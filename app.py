import json
import os
import re
import sqlite3
import zipfile
from pathlib import Path
from typing import Dict, List, Tuple
from uuid import uuid4

from flask import (
	Flask,
	abort,
	redirect,
	render_template,
	request,
	send_from_directory,
	url_for,
)


APP_ROOT = Path(__file__).parent.resolve()
TMP_ROOT = Path("/tmp/anki_preview").resolve()
TMP_ROOT.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)

# In-memory session registry. Keys are session ids, values are dicts with metadata.
SESSIONS: Dict[str, Dict] = {}


def _safe_join(base: Path, *paths: str) -> Path:
	candidate = (base.joinpath(*paths)).resolve()
	if not str(candidate).startswith(str(base)):
		raise ValueError("Attempted directory traversal")
	return candidate


def _read_media_mapping(extract_dir: Path) -> Tuple[Dict[str, str], Dict[str, str]]:
	"""Return (index->filename, filename->index) maps from the 'media' JSON if present."""
	media_json_path = extract_dir / "media"
	if media_json_path.exists():
		try:
			mapping = json.loads(media_json_path.read_text(encoding="utf-8"))
			index_to_filename = {str(k): v for k, v in mapping.items()}
			filename_to_index = {v: str(k) for k, v in mapping.items()}
			return index_to_filename, filename_to_index
		except Exception:
			pass
	return {}, {}


def _find_collection_file(extract_dir: Path) -> Path:
	candidates = [extract_dir / "collection.anki21", extract_dir / "collection.anki2"]
	for c in candidates:
		if c.exists():
			return c
	# Sometimes Anki exports nested, search recursively for collection.*
	for p in extract_dir.rglob("collection.anki2"):
		return p
	for p in extract_dir.rglob("collection.anki21"):
		return p
	raise FileNotFoundError("Could not find collection.anki2 or collection.anki21 in the archive")


FIELD_SEP = "\x1f"


def _apply_cloze(text: str, mask_for_question: bool) -> str:
	"""Very simple cloze handling: mask all clozes on question; reveal on answer."""
	# Matches {{c1::text}} or {{c2::text::hint}}
	pattern = re.compile(r"\{\{c\d+::(.*?)(?:::(.*?))?\}\}", re.DOTALL)

	def repl(match: re.Match) -> str:
		inner = match.group(1) or ""
		if mask_for_question:
			return "[… ]"
		hint = match.group(2)
		return inner if not hint else f"{inner} ({hint})"

	return pattern.sub(repl, text)


def _replace_field_tags(template_html: str, fields_by_name: Dict[str, str], mask_cloze_for_question: bool) -> str:
	html = template_html

	# Handle cloze:FieldName first
	def cloze_repl(m: re.Match) -> str:
		field_name = m.group(1).strip()
		value = fields_by_name.get(field_name, "")
		return _apply_cloze(value, mask_for_question=mask_cloze_for_question)

	html = re.sub(r"\{\{\s*cloze:([^}]+)\}\}", cloze_repl, html)

	# Handle filter:FieldName like text:Field
	def filter_repl(m: re.Match) -> str:
		field_name = m.group(2).strip()
		return fields_by_name.get(field_name, "")

	html = re.sub(r"\{\{\s*([a-zA-Z_]+):([^}]+)\}\}", filter_repl, html)

	# Handle simple {{FieldName}}
	def field_repl(m: re.Match) -> str:
		field_name = m.group(1).strip()
		return fields_by_name.get(field_name, "")

	html = re.sub(r"\{\{\s*([^}:]+)\s*\}\}", field_repl, html)

	return html


def _rewrite_media_paths(html: str, sid: str) -> str:
	# Rewrite <img src="filename"> where filename is not absolute
	def img_src_repl(m: re.Match) -> str:
		src = m.group(1)
		if re.match(r"^(?:https?://|data:|/)", src):
			return m.group(0)
		return f'src="/media/{sid}/{src}"'

	html = re.sub(r'src=["\']([^"\']+)["\']', img_src_repl, html)

	# Replace [sound:filename] with <audio>
	def sound_repl(m: re.Match) -> str:
		filename = m.group(1)
		return (
			f'<audio controls preload="none" src="/media/{sid}/{filename}"></audio>'
		)

	html = re.sub(r"\[sound:([^\]]+)\]", sound_repl, html)

	return html


def _parse_apkg_to_cards(extract_dir: Path, sid: str) -> List[Dict]:
	collection_path = _find_collection_file(extract_dir)

	conn = sqlite3.connect(str(collection_path))
	conn.row_factory = sqlite3.Row
	try:
		col_row = conn.execute("SELECT models FROM col").fetchone()
		models_json = col_row["models"] if col_row else "{}"
		models: Dict[str, Dict] = json.loads(models_json)

		# Build model lookup by id (as string)
		model_by_id: Dict[str, Dict] = {str(m.get("id")): m for m in models.values()}

		# Load notes
		notes_rows = conn.execute(
			"SELECT id, mid, flds, tags FROM notes"
		).fetchall()

		note_id_to_data: Dict[int, Dict] = {}
		for row in notes_rows:
			field_values = (row["flds"] or "").split(FIELD_SEP)
			model = model_by_id.get(str(row["mid"])) or {}
			field_names = [f.get("name", f"Field {i}") for i, f in enumerate(model.get("flds", []))]
			fields_by_name = {name: (field_values[i] if i < len(field_values) else "") for i, name in enumerate(field_names)}
			note_id_to_data[row["id"]] = {
				"model": model,
				"fields_by_name": fields_by_name,
				"tags": row["tags"] or "",
			}

		# Load cards and render
		cards_rows = conn.execute(
			"SELECT id, nid, ord, did FROM cards ORDER BY nid, ord"
		).fetchall()

		rendered_cards: List[Dict] = []
		for row in cards_rows:
			note = note_id_to_data.get(row["nid"])
			if not note:
				continue
			model = note["model"] or {}
			templates = model.get("tmpls", [])
			ord_index = row["ord"] or 0
			template = templates[ord_index] if ord_index < len(templates) else None
			if not template:
				continue

			qfmt = template.get("qfmt", "")
			afmt = template.get("afmt", "")
			fields_by_name = note["fields_by_name"]

			is_cloze_model = (model.get("type") == 1)
			front = _replace_field_tags(qfmt, fields_by_name, mask_cloze_for_question=is_cloze_model)
			back = _replace_field_tags(afmt, fields_by_name, mask_cloze_for_question=False)

			front = _rewrite_media_paths(front, sid)
			back = _rewrite_media_paths(back, sid)

			rendered_cards.append(
				{
					"id": row["id"],
					"note_id": row["nid"],
					"ord": ord_index,
					"deck_id": row["did"],
					"model_name": model.get("name", "Model"),
					"front_html": front,
					"back_html": back,
					"tags": note["tags"],
				}
			)

		return rendered_cards
	finally:
		conn.close()


def _extract_apkg_to_dir(apkg_path: Path, dest_dir: Path) -> None:
	with zipfile.ZipFile(apkg_path, "r") as zf:
		zf.extractall(dest_dir)


@app.route("/")
def index():
	return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
	file = request.files.get("apkg")
	if not file or not file.filename.lower().endswith(".apkg"):
		abort(400, "Please upload a .apkg file")

	sid = uuid4().hex
	session_dir = TMP_ROOT / sid
	session_dir.mkdir(parents=True, exist_ok=True)

	# Save uploaded file to disk
	apkg_path = session_dir / "deck.apkg"
	file.save(str(apkg_path))

	# Extract and parse
	extract_dir = session_dir / "extracted"
	extract_dir.mkdir(parents=True, exist_ok=True)
	_extract_apkg_to_dir(apkg_path, extract_dir)

	index_to_filename, filename_to_index = _read_media_mapping(extract_dir)

	cards = _parse_apkg_to_cards(extract_dir, sid)

	SESSIONS[sid] = {
		"session_dir": str(session_dir),
		"extract_dir": str(extract_dir),
		"cards": cards,
		"filename_to_index": filename_to_index,
	}

	return redirect(url_for("browse", sid=sid))


@app.route("/browse/<sid>")
def browse(sid: str):
	data = SESSIONS.get(sid)
	if not data:
		abort(404)
	cards = data["cards"]
	return render_template("browse.html", sid=sid, cards=cards)


@app.route("/media/<sid>/<path:filename>")
def media(sid: str, filename: str):
	data = SESSIONS.get(sid)
	if not data:
		abort(404)
	extract_dir = Path(data["extract_dir"]) 
	filename_to_index = data.get("filename_to_index", {})
	index_str = filename_to_index.get(filename)
	if index_str is None:
		# Some exports include original filenames directly; fall back to direct path
		file_path = _safe_join(extract_dir, filename)
		if file_path.exists() and file_path.is_file():
			return send_from_directory(extract_dir, filename)
		abort(404)

	file_on_disk = extract_dir / index_str
	if not file_on_disk.exists():
		abort(404)

	return send_from_directory(extract_dir, index_str, download_name=filename)


if __name__ == "__main__":
	port = int(os.environ.get("PORT", "5000"))
	app.run(host="0.0.0.0", port=port, debug=True)
