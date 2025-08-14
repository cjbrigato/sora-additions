import React from 'react';

const App: React.FC = () => (
  <>
    <style>{`
      :host, *, *::before, *::after { box-sizing: border-box; }
      @keyframes sb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

      #sora-launcher-button{
        position: fixed; right: 18px; bottom: 18px; width: 56px; height: 56px;
        border-radius: 50%; background:#111; color:#fff; display:flex; align-items:center; justify-content:center;
        box-shadow:0 8px 24px rgba(0,0,0,.35); cursor:pointer; z-index: 2147483647; border: 2px solid #444;
      }
      #sora-launcher-button:hover{ background:#151515; }
      #sora-launcher-border{ position:absolute; inset:2px; border-radius:50%; }

      #sora-downloader-panel{
        position: fixed; right: 18px; bottom: 18px; width: 560px; max-height: 74vh;
        display:none; flex-direction:column; gap:12px; background:#1e1e1e; color:#eee;
        border:1px solid #444; border-radius:12px; padding:12px; z-index: 2147483647; overflow: hidden;
        font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
        min-width: 0;
      }
      #sora-panel-header{
        display:flex; align-items:center; justify-content:space-between; gap:8px; border-bottom:1px solid #333; padding-bottom:6px;
      }
      #sora-close-button{ cursor:pointer; font-size:22px; padding:4px 8px; }
      #sora-close-button:hover{ color:#f55; }
      #sora-settings-button{
        background:transparent; border:1px solid #444; color:#ddd; padding:4px 8px; border-radius:8px; cursor:pointer;
      }
      #sora-settings-button:hover{ border-color:#777; color:#fff; }

      #sora-no-token-view{
        display:flex; align-items:center; justify-content:center; flex-direction:column; gap:8px; min-height:120px;
      }
      .sora-spinner{
        width: 40px; height: 40px; border: 4px solid #444; border-top-color: #3a86ff; border-radius: 50%;
        animation: sb-spin 1s linear infinite;
      }
      .sora-subtext{ font-size:12px; color:#aaa; max-width: 86%; text-align:center; }

      #sora-app-view{ display:flex; flex-direction:column; gap:10px; width:100%; min-width:0; }
      #sora-status{ font-size:13px; color:#bbb; }

      #sora-result-textarea{
        display:block; width:100%; max-width:100%;
        height: 200px; max-height: calc(70vh - 260px);
        background:#0b0b0b; color:#b8ffb8;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
        border:1px solid #333; border-radius:10px; padding:10px; white-space:pre;
        overflow-x:auto; overflow-y:auto;
      }
      #sora-result-textarea::-webkit-scrollbar{ width:10px; height:10px; }
      #sora-result-textarea::-webkit-scrollbar-track{ background:#0b0b0b; border-radius:8px; }
      #sora-result-textarea::-webkit-scrollbar-thumb{ background:#3a3a3a; border-radius:8px; border:2px solid #0b0b0b; }
      #sora-result-textarea::-webkit-scrollbar-thumb:hover{ background:#4a4a4a; }

      .sora-row{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .sora-btn{ background:#0d6efd; color:#fff; border:none; padding:8px 12px; border-radius:8px; cursor:pointer; }
      .sora-btn.secondary{ background:#2c2c2c; color:#ddd; border:1px solid #444; }
      .sora-btn.danger{ background:#a33; }
      .sora-btn:disabled{ opacity:0.6; cursor:not-allowed; }

      #sora-settings-panel{
        position: absolute; inset: 12px; background: #1a1a1a; border:1px solid #333; border-radius:10px; padding:10px; display:none;
        overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling: touch; min-width:0;
      }
      #sora-settings-panel::-webkit-scrollbar{ width:12px; height:12px; }
      #sora-settings-panel::-webkit-scrollbar-track{ background:#181818; border-radius:10px; }
      #sora-settings-panel::-webkit-scrollbar-thumb{ background:#3a3a3a; border-radius:10px; border:2px solid #1a1a1a; }
      #sora-settings-panel::-webkit-scrollbar-thumb:hover{ background:#4a4a4a; }

      .sora-settings-content{ display:flex; flex-direction:column; gap:12px; max-width:100%; min-width:0; }
      #sora-settings-header{ display:flex; align-items:center; justify-content:space-between; }

      .sora-row-compact{ display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .sora-row-compact > label{ color:#ccc; }

      .sora-row-block{ display:flex; flex-direction:column; align-items:flex-start; gap:8px; padding-top:4px; }
      .sora-setting-group{ border-top:1px solid #333; padding-top:10px; margin-top:6px; }
      .sora-setting-inactive{ opacity:0.5; pointer-events:none; }
      .sora-subnote{ font-size:12px; color:#9aa; margin-top:2px; }

      input[type="number"], select{
        background:#111; color:#eee; border:1px solid #444; border-radius:6px; padding:6px; min-width: 120px;
      }

      #sora-mini-badge{
        position: fixed; right: 18px; bottom: 84px;
        padding: 6px 10px; color:#fff;
        border-radius: 999px; font-size: 12px; box-shadow:0 6px 18px rgba(0,0,0,.35);
        display: none; z-index: 2147483647; user-select:none;
        background:#0d6efd;
      }
      #sora-mini-badge.dl  { background:#0d6efd; }
      #sora-mini-badge.zip { background:#8b5cf6; }

      #sora-progress{
        display:none; align-items:center; justify-content:center; flex-direction:column;
        gap:10px; padding:10px 0; min-height: 88px;
      }
      .sb-ring{
        width:56px; height:56px; border-radius:50%;
        background: conic-gradient(#0d6efd var(--pct,0%), #2e2e2e var(--pct,0%));
        -webkit-mask: radial-gradient(circle 22px at 50% 50%, transparent 21px, black 22px);
                mask: radial-gradient(circle 22px at 50% 50%, transparent 21px, black 22px);
        box-shadow: inset 0 0 0 2px #1d1d1d, 0 0 0 1px #0008;
      }
      .sb-main{ color:#ddd; font-size:14px; text-align:center; }
      .sb-sub{  color:#aaa; font-size:12px; text-align:center; max-width:90%;
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    `}</style>

    <div id="sora-launcher-button" title="Open Sora Batch Downloader">
      <div id="sora-launcher-border"></div>
      <svg id="sora-launcher-icon" width="26" height="26" viewBox="0 0 24 24" fill="none">
        <path d="M12 4V16M12 16L8 12M12 16L16 12" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M4 20H20" stroke="white" strokeWidth="2" strokeLinecap="round"/>
      </svg>
    </div>

    <div id="sora-downloader-panel">
      <div id="sora-panel-header">
        <button id="sora-settings-button" title="Settings" style={{display:'none'}}>⚙️ Settings</button>
        <h3 style={{margin:0}}>Sora Batch Downloader</h3>
        <div id="sora-close-button" title="Close">&times;</div>
      </div>

      <div id="sora-no-token-view">
        <div className="sora-spinner"></div>
        <p>Awaiting Token...</p>
        <p className="sora-subtext">Browse Sora (view/create a video) to activate the downloader.</p>
      </div>

      <div id="sora-app-view">
        <div className="sora-row">
          <button id="sora-run-button" className="sora-btn">Generate Download Script</button>
          <button id="sora-stop-button" className="sora-btn danger" style={{display:'none'}}>Stop</button>
          <button id="sora-copy-button" className="sora-btn secondary" style={{display:'none'}}>Copy Script</button>
          <button id="sora-export-manifest-btn" className="sora-btn secondary" style={{display:'none'}}>Export Manifest (CSV/JSON)</button>
        </div>

        <div id="sora-progress">
          <div className="sb-ring" id="sb-ring"></div>
          <div className="sb-main" id="sb-main"></div>
          <div className="sb-sub"  id="sb-sub"></div>
        </div>

        <div id="sora-status">Ready.</div>
        <textarea id="sora-result-textarea" readOnly placeholder="# The script will appear here..."></textarea>
      </div>

      <div id="sora-settings-panel">
        <div className="sora-settings-content">
          <div id="sora-settings-header">
            <h4 style={{margin:0}}>Settings</h4>
            <button id="sora-settings-close-button">✖</button>
          </div>

          <div className="sora-row-block">
            <label><input type="radio" name="sora-mode" id="sora-mode-final" /> Final Quality</label>
            <label><input type="radio" name="sora-mode" id="sora-mode-fast" /> Fast Preview</label>
          </div>

          <div className="sora-row-compact" id="sora-fast-quality-container">
            <label htmlFor="sora-fast-quality-select">Preview quality</label>
            <select id="sora-fast-quality-select">
              <option value="source">source</option>
              <option value="md">md</option>
              <option value="ld">ld</option>
            </select>
          </div>

          <div className="sora-row-compact" id="sora-parallel-container">
            <label htmlFor="sora-parallel-input">Workers</label>
            <input id="sora-parallel-input" type="number" min="1" max="20" />
          </div>

          <div className="sora-row-compact" id="sora-limit-row">
            <label htmlFor="sora-limit-input">Task Limit</label>
            <input id="sora-limit-input" type="number" min="1" />
          </div>

          <div className="sora-row-compact">
            <label htmlFor="sora-dryrun-checkbox">Dry Run</label>
            <input id="sora-dryrun-checkbox" type="checkbox" />
          </div>

          <div className="sora-setting-group">
            <div className="sora-row-compact">
              <label htmlFor="sora-direct-checkbox">Direct Download</label>
              <input id="sora-direct-checkbox" type="checkbox" />
            </div>
            <div className="sora-row-compact">
              <label htmlFor="sora-direct-max">Max Tasks</label>
              <input id="sora-direct-max" type="number" min="1" max="100" />
            </div>
            <div className="sora-row-compact">
              <label htmlFor="sora-direct-parallel">Parallel</label>
              <input id="sora-direct-parallel" type="number" min="1" max="6" />
            </div>
            <div className="sora-row-compact">
              <label htmlFor="sora-direct-saveas">Save As</label>
              <input id="sora-direct-saveas" type="checkbox" />
            </div>
            <div className="sora-row-compact">
              <label htmlFor="sora-direct-zip">ZIP Batch</label>
              <input id="sora-direct-zip" type="checkbox" />
            </div>
          </div>

          <button id="sora-settings-save-button" className="sora-btn secondary">Save</button>
        </div>
      </div>

    </div>

    <div id="sora-mini-badge"></div>
  </>
);

export default App;
