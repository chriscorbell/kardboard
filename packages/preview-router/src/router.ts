import http from "node:http";
import { COOKIE_NAME, cookieHeader, forwardHeaders, holdingPage, readCookies, responseHeaders, safeNext, signInRedirect, verifyCookie, type Route } from "./preview.js";

// The request handling half of the preview router, kept apart from the process so a test can drive
// it against a local upstream. `index.ts` builds the config from the environment and listens.
//
// Every Preview on the host sits behind this one process, so nothing a request carries, and nothing
// a Preview or the app answers, may throw out of it: one bad request would take every Preview down.

export type ExchangeResult = { cookie: string; maxAgeSeconds: number } | { error: string };

export type RouterConfig = {
  route: (host: string) => Route | undefined;
  /** Spends a single-use sign-in code with the app. Rejects when the app cannot be reached. */
  exchange: (code: string, host: string) => Promise<ExchangeResult>;
  secret: string;
  publicAppUrl: string;
  secureCookies: boolean;
};

// Once the status line has gone out the only honest answer left is to cut the connection.
function fail(res: http.ServerResponse, status: number, message: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

export function createRouter(config: RouterConfig): http.RequestListener {
  function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.url === "/healthz") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    const host = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
    const route = config.route(host);
    if (!route) {
      fail(res, 404, "No preview at this address.");
      return;
    }

    // Only a path is proxied. It is appended to the host by hand rather than resolved against it,
    // because resolving `//x:99999` reads it as a host and port and throws.
    const path = req.url ?? "/";
    if (!path.startsWith("/")) {
      fail(res, 400, "Bad request.");
      return;
    }
    const url = new URL(`http://${host}${path}`);

    // Step two of the sign-in redirect: spend the code, set a host-only cookie, carry on.
    if (url.pathname === "/__kardboard/auth") {
      const code = url.searchParams.get("code") ?? "";
      const next = safeNext(url.searchParams.get("next"), host);
      config
        .exchange(code, host)
        .then((result) => {
          if ("error" in result) return fail(res, 403, result.error);
          res.writeHead(302, { "set-cookie": cookieHeader(result.cookie, result.maxAgeSeconds, config.secureCookies), location: next });
          res.end();
        })
        .catch((err: Error) => {
          console.error("[preview-router] sign-in exchange failed", err.message);
          fail(res, 502, "kardboard could not be reached to finish signing you in. Try again in a moment.");
        });
      return;
    }

    if (!readCookies(req.headers.cookie, COOKIE_NAME).some((value) => verifyCookie(value, host, route, config.secret))) {
      res.writeHead(302, { location: signInRedirect(config.publicAppUrl, host, path) });
      res.end();
      return;
    }

    const hold = () => {
      const { status, body } = holdingPage(route, host);
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };

    // A rebuild leaves the previous container serving until its replacement starts, so a Member
    // keeps a working Preview in the meantime and the Card says it is rebuilding. The holding page
    // is for when there is nothing to serve: a first build, or a failed one, whose error it shows.
    const serving = route.status === "failed" ? null : route.target;
    if (!serving) {
      hold();
      return;
    }

    const target = new URL(serving);
    const upstream = http.request(
      { hostname: target.hostname, port: target.port, path, method: req.method, headers: forwardHeaders(req.headers, target.host) },
      (up) => {
        up.on("error", () => res.destroy());
        try {
          res.writeHead(up.statusCode ?? 502, responseHeaders(up.headers));
        } catch (err) {
          up.destroy();
          console.error("[preview-router] could not relay the preview's response", (err as Error).message);
          fail(res, 502, "Preview sent a response that could not be relayed.");
          return;
        }
        up.pipe(res);
      },
    );
    // The one moment a rebuild has nothing to serve is the swap, between removing the old container
    // and starting the new one; a visitor then gets the holding page rather than an error.
    upstream.on("error", () => {
      if (route.status === "building" && !res.headersSent) hold();
      else fail(res, 502, "Preview is not responding.");
    });
    req.on("error", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  return (req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      console.error("[preview-router] request failed", (err as Error).message);
      fail(res, 500, "The preview router could not handle that request.");
    }
  };
}
