# Sora Batch Downloader

This Tampermonkey userscript integrates directly into the Sora web interface, providing an intuitive UI for generating batch download scripts for your videos. 
To circumvent the overall pain that feels any heavy sora user regarding downloading their work

## In Action



## Features

-   **Two Download Modes:**
    -   **Final Quality:** Fetches the pristine, watermark-free version of your videos (if your plan allows it). This is the recommended mode for archival and production use.
    -   **Fast Preview:** Instantly generates a script using the watermarked preview versions, perfect for quickly getting review copies.
-   **Smart when possible:**
    -   **Permission-Aware:** Automatically queries your user permissions upon loading. The "Final Quality" option is disabled if your account does not have rights to download without a watermark.
    -   **Filtering:** Proactively filters out generations that failed due to content policy, processing errors, or other issues, preventing unnecessary requests and errors.
    -   **Dynamic Feedback:** real time indicating both activity and progress.
    -   **Detailed Output:** The generated `bash` script is commented with a summary of the operation, including a list of any videos that were skipped and why.

## Example Script Output

The script provides clear feedback directly in the generated file, so you always know which videos were skipped and why, without having to check the console.

```bash
#!/bin/bash
# Download script for 168 Sora videos (6 skipped)
# Mode: Final Quality (No Watermark)
# Format: curl

# --- SKIPPED (pre-check) ---
# task_01k2aymxfse43tpebvc1k5fqm1: input_moderation
# task_01k2crmva3e3kbvz6x3anystky: processing_error
# gen_01k2ghtdd4etn8266an4fc1rrv: Generation failed (missing video file)

# --- FAILED during URL fetch ---
# gen_01k2gvh46tfv89s4nh28q1njtb: API Error 500

echo "Starting download of 168 videos..."

curl -L -C - -o "sora_gen_01k2gej4bzecaa30yqknj688kd.mp4" "https://..."
curl -L -C - -o "sora_gen_01k2gah46mf1ja0mg3hpbeev2m.mp4" "https://..."
# ...and 166 more video downloads...

echo "Download completed!"
```

## How to Use

1.  **Install a Userscript Manager:** You need a browser extension like [Tampermonkey](https://www.tampermonkey.net/) (recommended) or Greasemonkey.
2.  **Install the Script:** Create a new script in Tampermonkey and paste the entire `.js` file content.
3.  **Browse Sora:** Navigate to `https://sora.chatgpt.com/`. You will see a new circular icon appear in the bottom-right corner.
4.  **Activate the Downloader:** At first, the panel will show "Awaiting Token...". Simply use the Sora site normally (e.g., click on a video or create a new one). The script will automatically capture the necessary credentials and unlock the interface.
5.  **Generate Script:** Click the launcher icon to open the panel. Click the settings cog (⚙️) to configure your download mode and other options, then click "Generate Download Script".
6.  **Run in Terminal:** Copy the generated script from the text area, save it to a file (e.g., `sora_downloads.sh`), make it executable (`chmod +x sora_downloads.sh`), and run it in your terminal (`./sora_downloads.sh`).

## Limitations

-   **This is a script generator, not a direct in-browser downloader.** It produces a `bash` script that you must run from a command-line terminal (`curl` is required). This method is far more reliable for downloading a large number of large files.
-   The script depends on the current structure of the Sora website and its internal APIs. Future updates by OpenAI may require adjustments to this script to maintain functionality.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Notes of conception:
See [this file](.llm.md) for more information