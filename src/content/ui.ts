export type UIRefs = {
    root: ShadowRoot;
    // launcher
    launch: HTMLElement; ring: HTMLElement; badge: HTMLElement;
    // panel
    panel: HTMLElement; hdrClose: HTMLElement; btnSettings: HTMLButtonElement;
    awaitBox: HTMLElement; appBox: HTMLElement;
    runBtn: HTMLButtonElement; stopBtn: HTMLButtonElement; copyBtn: HTMLButtonElement; exportBtn: HTMLButtonElement;
    status: HTMLElement; out: HTMLTextAreaElement;
    // HUD
    hudWrap: HTMLElement; hudRing: HTMLElement; hudMain: HTMLElement; hudSub: HTMLElement;
    // settings
    settings: HTMLElement;
    modeFinal?: HTMLInputElement; modeFast?: HTMLInputElement;
    fastqRow?: HTMLElement; fastq?: HTMLSelectElement;
    parallelRow?: HTMLElement; parallel?: HTMLInputElement;
    limitRow?: HTMLElement; limit?: HTMLInputElement;
    dry?: HTMLInputElement;
    direct?: HTMLInputElement; maxTasks?: HTMLInputElement; dParallel?: HTMLInputElement; saveAs?: HTMLInputElement; zip?: HTMLInputElement;
    btnSave?: HTMLButtonElement;
    shadowIsLoaded: boolean;
};

export async function buildUI(): Promise<UIRefs> {
    const host = document.createElement('div');
    host.style.all = 'initial';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    let shadowIsLoaded = false;
    // actually fetch synchronously the shadow.html file and put content into root.innerHTML
    const shadow =  fetch(chrome.runtime.getURL('shadow.html')).then(res => res.text()).then(text => {
        root.innerHTML = text;
        shadowIsLoaded = true;
    });

    // wait for shadowIsLoaded to be true
    while (!shadowIsLoaded) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const $ = (id: string) => root.getElementById(id)!;

    return {
        root,
        launch: $('launch'), ring: $('ring'), badge: $('badge'),
        panel: $('panel'), hdrClose: $('close') as HTMLElement, btnSettings: $('btn-settings') as HTMLButtonElement,
        awaitBox: $('await'), appBox: $('app'),
        runBtn: $('run') as HTMLButtonElement, stopBtn: $('stop') as HTMLButtonElement, copyBtn: $('copy') as HTMLButtonElement, exportBtn: $('export') as HTMLButtonElement,
        status: $('status'), out: $('out') as HTMLTextAreaElement,
        hudWrap: $('hud'), hudRing: $('hud-ring'), hudMain: $('hud-main'), hudSub: $('hud-sub'),
        settings: $('settings'),
        modeFinal: $('mode-final') as HTMLInputElement, modeFast: $('mode-fast') as HTMLInputElement,
        fastqRow: $('fastq-row'), fastq: $('fastq') as HTMLSelectElement,
        parallelRow: $('parallel-row'), parallel: $('parallel') as HTMLInputElement,
        limitRow: $('limit-row'), limit: $('limit') as HTMLInputElement,
        dry: $('dry') as HTMLInputElement,
        direct: $('direct') as HTMLInputElement, maxTasks: $('maxTasks') as HTMLInputElement, dParallel: $('dParallel') as HTMLInputElement, saveAs: $('saveAs') as HTMLInputElement, zip: $('zip') as HTMLInputElement,
        btnSave: $('btn-save') as HTMLButtonElement,
        shadowIsLoaded
    };
}
