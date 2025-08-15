# Sora Batch Downloader

Chrome extension that plugs **directly** into Sora’s UI to help you retrieve your own generations — fast, reliably, and without fighting the site every time.

## In Action
<img width="456" height="303" alt="image" src="https://github.com/user-attachments/assets/15437475-4b86-468c-9961-2a45f922b96c" />
<img width="440" height="395" alt="image" src="https://github.com/user-attachments/assets/39efb106-6ef7-46c8-97c2-846aae5bb028" />
<img width="453" height="135" alt="image" src="https://github.com/user-attachments/assets/6c9c985c-1e82-47f2-8ccc-8328669b3d1c" />


## Features
* Supports **images** and **videos** batch download

* **Retrieval modes**
  * **ZIP mode (default, batches):** downloads files **locally**, then streams a **single ZIP (STORE)** and triggers **one** browser download. Respects Chrome’s *Always ask where to save*; appears once in the Downloads list. Flow: **DL → OPFS → ZIP → single browser download**.
* **Smart & safe**
  * **Task-gating:** Direct/ZIP operates on up to **N tasks** (cap configurable), with the website list also capped at **100** by design. Each task can yield **up to 4 videos**.
  * **Permission-aware:** if your plan doesn’t allow watermark-free download, **Final** is disabled; you can still use **Fast Preview**.
  * **Filtering:** skips failed/moderated generations; shows reasons in the output.
* **UX**

  * **Shadow DOM UI**: clean launcher (bottom-right), panel with settings.
  * **HUD** during operations: ring + two lines in the panel, and a **mini badge** on the launcher when the panel is closed (DL x/y → ZIP x/y).
  * **Stop** button cancels downloads and ZIP cleanly.
* **Script fallback**

  * Always generates a robust `curl` script with comments (skipped/failed), so you can mirror the operation from a terminal if needed.

## Modes & Options (quick overview)

* **Download Mode**
  * **Final Quality** (no watermark) — if allowed by your plan.
  * **Fast Preview** (watermarked source/MD/LD).
* **Enable**, **Max tasks**, **Parallel** (1–6).

## Install

1. **Clone** (or download) this repo locally.
# build via npm
2. run `npm install`
3. run `npm run dev` for local development on `npm run build` for production build
4. Open `chrome://extensions` → toggle **Developer mode**.
5. Click **Load unpacked** → select the project's `dist` folder.
6. Go to `https://sora.chatgpt.com/` — a round launcher appears bottom-right.

> The extension works entirely client-side.
> The bearer token is captured in-page and stored in **`chrome.storage.session`** (memory only), not persisted to disk, and never sent to external servers.

## Use

1. Open Sora and interact normally; the panel may show **“Awaiting Token…”** until you view/create a video.
2. Click the launcher → **Settings** (⚙️) to choose mode & options.
3. Click **Zip & Download** (ZIP mode)  or **Generate Download Script** (fallback).
4. Watch the HUD (panel) and the mini badge (closed panel) for **DL x/y** then **ZIP x/y**.
5. When ZIP finishes, the extension triggers **one browser download** of the `.zip`.

## Example Script Output

The generated script includes comments about skipped/failed items and uses resilient flags.

```bash
#!/bin/bash
# Download script for 168 Sora videos (6 skipped)
# Mode: Final Quality (No Watermark)
# Format: curl

# --- SKIPPED (pre-check) ---
# task_01k2crmva3e3kbvz6x3anystky: processing_error
# gen_01k2ghtdd4etn8266an4fc1rrv: Generation failed (missing video file)

# --- FAILED during URL fetch ---
# gen_01k2gvh46tfv89s4nh28q1njtb: API Error 500

echo "Starting download of 168 videos..."

curl -L -C - --fail --retry 5 --retry-delay 2 -o "sora_gen_01k2gej4bzecaa30yqknj688kd.mp4" "https://..."
# …
echo "Download completed!"
```

## Troubleshooting

* **Stuck on “Awaiting Token…”**
  View or create a video to trigger authenticated requests. If idle for long, reload Sora (the token is re-captured automatically).
* **Nothing downloads in ZIP mode**
  Ensure Chrome’s Downloads are allowed. ZIP appears **once** at the end. If you use *Always ask where to save*, the Save dialog appears **only at the end**.
* **Stop button doesn’t clear UI**
  It should; if you killed the tab during DL/ZIP, just reopen the panel — the HUD resets automatically.
* **Hit the 100 limit**
  By design: list fetch is capped at **100**. Use the **Max tasks** setting to slice your batches.

## Limitations

* **Capped list**: Sora fetch is limited to 100; the tool is built for **frequent, small-to-medium** batches, not “export everything”.
* **ZIP format**: current ZIP is classic PKZIP (no ZIP64). If single files or offsets exceed 4 GB, we’ll upgrade to ZIP64.
* Subject to Sora UI/API changes.

## License

MIT — see `LICENSE`.

## Notes of conception

See **[.llm](.llm)** for provenance, model contributions, and changelog.
