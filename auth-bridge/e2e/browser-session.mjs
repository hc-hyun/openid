function decodeHtml(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function attributes(source) {
  const result = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function defaultCookiePath(pathname) {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash + 1);
}

function domainMatches(hostname, cookie) {
  return cookie.hostOnly
    ? hostname === cookie.domain
    : hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
}

function pathMatches(pathname, cookiePath) {
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || pathname[cookiePath.length] === "/";
}

export function parseForms(html) {
  const forms = [];
  const pattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  for (const match of String(html).matchAll(pattern)) {
    const formAttributes = attributes(match[1]);
    const inputs = [];
    for (const input of match[2].matchAll(/<(?:input|button)\b([^>]*)>/gi)) {
      const inputAttributes = attributes(input[1]);
      if (inputAttributes.name) inputs.push(inputAttributes);
    }
    forms.push({
      id: formAttributes.id,
      action: formAttributes.action,
      method: (formAttributes.method ?? "GET").toUpperCase(),
      inputs,
      html: match[0],
    });
  }
  return forms;
}

export function formById(html, id) {
  return parseForms(html).find((form) => form.id === id);
}

export function formWithInput(html, inputName) {
  return parseForms(html).find((form) =>
    form.inputs.some((input) => input.name === inputName),
  );
}

export class BrowserSession {
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.onRequest = options.onRequest;
    this.cookies = new Map();
  }

  updateCookies(response, requestUrl) {
    for (const header of response.headers.getSetCookie()) {
      const parts = header.split(";");
      const separator = parts[0].indexOf("=");
      if (separator <= 0) continue;
      const name = parts[0].slice(0, separator).trim();
      const value = parts[0].slice(separator + 1).trim();
      const cookie = {
        name,
        value,
        domain: requestUrl.hostname.toLowerCase(),
        hostOnly: true,
        path: defaultCookiePath(requestUrl.pathname),
        secure: false,
      };
      let remove = !value;
      for (const rawAttribute of parts.slice(1)) {
        const attributeSeparator = rawAttribute.indexOf("=");
        const key = (attributeSeparator < 0 ? rawAttribute : rawAttribute.slice(0, attributeSeparator))
          .trim()
          .toLowerCase();
        const attributeValue = attributeSeparator < 0
          ? ""
          : rawAttribute.slice(attributeSeparator + 1).trim();
        if (key === "domain" && attributeValue) {
          cookie.domain = attributeValue.replace(/^\./, "").toLowerCase();
          cookie.hostOnly = false;
        } else if (key === "path" && attributeValue.startsWith("/")) {
          cookie.path = attributeValue;
        } else if (key === "secure") {
          cookie.secure = true;
        } else if (key === "max-age" && Number(attributeValue) <= 0) {
          remove = true;
        } else if (key === "expires" && Number.isFinite(Date.parse(attributeValue))) {
          if (Date.parse(attributeValue) <= Date.now()) remove = true;
        }
      }
      const storageKey = `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
      if (remove) this.cookies.delete(storageKey);
      else this.cookies.set(storageKey, cookie);
    }
  }

  cookieHeader(url) {
    const secureContext =
      url.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    return Array.from(this.cookies.values())
      .filter((cookie) =>
        domainMatches(url.hostname.toLowerCase(), cookie) &&
        pathMatches(url.pathname, cookie.path) &&
        (!cookie.secure || secureContext),
      )
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  async request(initialUrl, initialOptions = {}) {
    let url = new URL(initialUrl);
    let method = (initialOptions.method ?? "GET").toUpperCase();
    let body = initialOptions.body;
    let headers = new Headers(initialOptions.headers);

    for (let redirects = 0; redirects <= 30; redirects += 1) {
      const cookie = this.cookieHeader(url);
      if (cookie) headers.set("Cookie", cookie);
      else headers.delete("Cookie");
      this.onRequest?.({ url: new URL(url), method, headers: new Headers(headers) });

      const response = await this.fetch(url, {
        method,
        body,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      this.updateCookies(response, url);

      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} did not include Location`);
      url = new URL(location, url);
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers = new Headers();
      }
    }
    throw new Error("Too many browser redirects");
  }

  submitForm(pageUrl, form, overrides = {}) {
    if (!form?.action) throw new Error("Cannot submit a form without an action");
    const parameters = new URLSearchParams();
    for (const input of form.inputs) {
      const type = (input.type ?? "text").toLowerCase();
      if (["button", "reset", "file"].includes(type)) continue;
      if (["submit", "image"].includes(type) && overrides[input.name] === undefined) continue;
      parameters.append(input.name, overrides[input.name] ?? input.value ?? "");
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (!form.inputs.some((input) => input.name === name)) parameters.set(name, value);
      else parameters.set(name, value);
    }
    return this.request(new URL(form.action, pageUrl), {
      method: form.method === "GET" ? "GET" : "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.method === "GET" ? undefined : parameters,
    });
  }
}
