// The loader and frame scripts run here in a happy-dom Window, the way a browser runs them on a host page.
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { FRAME_JS, frameJs, LOADER_JS, snippets } from "../src/index.js";

// happy-dom refuses to load iframe pages (good: no network) and reports each one on its console; keep that quiet.
const silent = { ...console, error: () => {}, warn: () => {}, log: () => {} } as Console;
let w: Window;
afterEach(async () => { await w?.happyDOM.close(); });

function page(body: string): Window {
  w = new Window({ url: "https://host.example/page", console: silent, settings: { disableJavaScriptFileLoading: true } });
  w.document.body.innerHTML = body;
  return w;
}
/** Runs a script string with the page's globals, as if a <script> tag were executing (currentScript = `me`). */
function run(code: string, me: unknown = null) {
  const doc = w.document;
  Object.defineProperty(doc, "currentScript", { configurable: true, get: () => me });
  new Function("document", "addEventListener", "parent", "location", "ResizeObserver", code)(doc, w.addEventListener.bind(w), w.parent, w.location, w.ResizeObserver);
}
const frames = () => [...w.document.querySelectorAll("iframe")];

describe("LOADER_JS", () => {
  it("puts an iframe after each tag, with the item URL built from the data attributes", () => {
    page(`<p>a</p><script id="s1" src="https://w.example/embed.js" data-nearkit-store="ann b" data-nearkit-item="i/1"></script><script data-nearkit-store="bob"></script>`);
    const me = w.document.getElementById("s1");
    run(LOADER_JS(), me);
    const [one, all] = frames();
    expect(frames()).toHaveLength(2);
    expect(one!.getAttribute("src")).toBe("https://w.example/embed/ann%20b/i/i%2F1");
    expect(one!.previousElementSibling).toBe(me);
    expect(one!.style.height).toBe("520px");
    expect(one!.style.maxWidth).toBe("420px");
    expect((one as unknown as { loading: string }).loading).toBe("lazy");
    expect(all!.getAttribute("src")).toBe("https://w.example/embed/bob");
    expect(all!.style.height).toBe("640px");
    run(LOADER_JS(), me); // the same script on the page twice doesn't add frames twice
    expect(frames()).toHaveLength(2);
  });

  it("uses a given origin, path templates and attr", () => {
    page(`<script data-shop-store="ann" data-shop-item="cake"></script><script data-nearkit-store="other"></script>`);
    run(LOADER_JS("https://api.example", { item: "/h/{store}/embed/i/{item}" }, { attr: "shop", title: "Buy on Ann's" }));
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.getAttribute("src")).toBe("https://api.example/h/ann/embed/i/cake");
    expect(frames()[0]!.title).toBe("Buy on Ann's");
  });

  it("resizes only on a height message from its own frame and origin", () => {
    page(`<script data-nearkit-store="ann"></script>`);
    run(LOADER_JS("https://w.example"));
    const f = frames()[0]!;
    const send = (origin: string, source: unknown, data: unknown) => w.dispatchEvent(new w.MessageEvent("message", { origin, source: source as never, data }));
    send("https://evil.example", f.contentWindow, { nearkit: "height", h: 999 });
    expect(f.style.height).toBe("640px");
    send("https://w.example", w, { nearkit: "height", h: 999 }); // right origin, wrong window
    expect(f.style.height).toBe("640px");
    send("https://w.example", f.contentWindow, { nearkit: "height", h: "1;color:red" });
    expect(f.style.height).toBe("640px");
    send("https://w.example", f.contentWindow, { nearkit: "height", h: 333.2 });
    expect(f.style.height).toBe("334px");
  });

  it("rejects an attr that could break the selector", () => {
    expect(() => LOADER_JS(null, {}, { attr: 'x"]' })).toThrow();
  });
});

describe("FRAME_JS", () => {
  it("posts its height to the parent", () => {
    page("<p>card</p>");
    const seen: unknown[][] = [];
    w.parent.postMessage = ((...a: unknown[]) => { seen.push(a); }) as never;
    run(FRAME_JS);
    expect(seen.length).toBeGreaterThan(0);
    const [msg, target] = seen[0] as [{ nearkit: string; h: number; src: string }, string];
    expect(msg).toMatchObject({ nearkit: "height", src: "/page" });
    expect(typeof msg.h).toBe("number");
    expect(target).toBe("*");
    expect(frameJs("my-shop")).toContain('{"myShop":"height"');
  });
});

describe("snippets", () => {
  it("builds the script and iframe a site owner pastes", () => {
    const s = snippets({ base: "https://shop.example/", store: "ann", item: "cake" });
    expect(s.script).toBe('<script src="https://shop.example/embed.js" data-nearkit-store="ann" data-nearkit-item="cake" async></script>');
    expect(s.iframe).toContain('src="https://shop.example/embed/ann/i/cake"');
  });
});
