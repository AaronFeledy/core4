import { readFile } from "node:fs/promises";
import { Parser } from "htmlparser2";
import { LinkState } from "linkinator";

function parseHtml(html) {
  const ids = new Set();
  const references = [];
  let baseHref;
  const parser = new Parser({
    onopentag(name, attributes) {
      if (attributes.id !== undefined) ids.add(attributes.id);
      if (name === "a" && attributes.name !== undefined) ids.add(attributes.name);
      if (name === "base") {
        baseHref ??= attributes.href;
        return;
      }
      for (const attribute of ["href", "xlink:href", "src", "action", "data"]) {
        const value = attributes[attribute];
        if (value?.includes("#")) references.push(value);
      }
    },
  });
  parser.end(html);
  return { ids, references, baseHref };
}

export async function checkStrictFragments(pages, localUrl) {
  const cache = new Map();
  const documents = [];
  const key = (url) => `${url.origin}${url.pathname}`;
  for (const page of pages) {
    const parsed = parseHtml(await readFile(page.file, "utf8"));
    cache.set(key(new URL(page.url)), Promise.resolve(parsed.ids));
    documents.push({ ...page, ...parsed });
  }
  const loadTarget = async (initialUrl) => {
    let url = initialUrl;
    for (let redirects = 0; redirects < 10; redirects++) {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = localUrl(new URL(location, url));
        if (!url) return undefined;
        continue;
      }
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
        await response.body?.cancel();
        return undefined;
      }
      return parseHtml(await response.text()).ids;
    }
    throw new Error("Too many local fragment-target redirects");
  };
  const links = [];
  let checked = 0;
  for (const document of documents) {
    const documentBase = new URL(document.baseHref ?? document.url, document.url);
    for (const reference of document.references) {
      let target;
      let fragment;
      try {
        target = localUrl(new URL(reference, documentBase));
        if (!target?.hash) continue;
        fragment = decodeURIComponent(target.hash.slice(1).split(":~:")[0]);
      } catch {
        // Linkinator reports malformed URLs separately.
        continue;
      }
      if (!fragment || fragment.toLowerCase() === "top") continue;
      const targetKey = key(target);
      if (!cache.has(targetKey)) {
        const requestUrl = new URL(target);
        requestUrl.hash = "";
        cache.set(targetKey, loadTarget(requestUrl));
      }
      try {
        const ids = await cache.get(targetKey);
        if (!ids) continue;
        checked++;
        if (ids.has(fragment)) continue;
        links.push({
          url: target.href,
          parent: document.url,
          state: LinkState.BROKEN,
          status: 200,
          failureDetails: [new Error(`Missing HTML fragment: #${fragment}`)],
        });
      } catch (error) {
        links.push({
          url: target.href,
          parent: document.url,
          state: LinkState.BROKEN,
          status: 0,
          failureDetails: [error],
        });
      }
    }
  }
  return { links, checked };
}
