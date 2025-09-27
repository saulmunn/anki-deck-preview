# anki-deck-preview

Preview the contents of Anki (.apkg) files, so that you don't need to add them to your collection just to browse through them.

## Static usage (no server)

Just open `index.html` in a modern browser. Everything runs locally in the tab using WebAssembly and JS.

- Click "Preview" with a `.apkg` selected to parse it.
- No data leaves your device.
- Works best in recent Chrome/Edge/Safari/Firefox.

If your browser blocks `file://` for WASM, serve the folder with a simple static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## (Optional) Flask server (legacy)

You can still run the previous Flask version if you prefer:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export FLASK_APP=app.py
python3 -m flask run --host 0.0.0.0 --port 5000
```

Open `http://localhost:5000` in your browser.

## Setup

1. Create and activate a virtual environment (recommended):

```bash
python3 -m venv .venv
source .venv/bin/activate
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

## Run

```bash
FLASK_APP=app.py flask run --host 0.0.0.0 --port 5000
```

Open `http://localhost:5000` in your browser.

## Usage

- Upload a `.apkg` file exported from Anki.
- The app extracts it locally in a temporary directory and lists all cards.
- Click "Flip" on any card to view the back.
- Use the search box to filter by text.

## Notes

- This is a local previewer; it is not affiliated with Anki.
- Media is served directly from the extracted archive via a per-session route.
- Cloze deletions are rendered simply: masked on the question side, revealed on the answer side.
