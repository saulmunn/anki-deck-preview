# anki-deck-preview

Preview the contents of Anki (.apkg) files, so that you don't need to add them to your collection just to browse through them.

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
