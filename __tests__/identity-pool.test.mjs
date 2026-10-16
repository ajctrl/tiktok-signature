import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const serverUrl = new URL("../server.mjs", import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function harness({ poolSize = 2, failedSignatures = 0, env = {} } = {}) {
  const contexts = [];
  const controls = {
    failedSignatures,
    beforeSign: null,
    beforeNavigate: null,
    beforeFetch: null,
    tokens: {},
    now: Date.now(),
  };
  let handler;
  const browser = {
    connected: true,
    on() {},
    async createBrowserContext() {
      const identity = contexts.length + 1;
      const context = {
        closed: false,
        async close() {
          this.closed = true;
        },
      };
      contexts.push(context);
      const browserGlobals = vm.createContext({
        URL,
        navigator: { userAgent: "test browser" },
        document: {
          get cookie() {
            return `msToken=${controls.tokens[identity] || `token-${identity}`}`;
          },
          body: { innerText: "" },
          querySelectorAll: () => [],
        },
        window: {
          scrollBy() {},
          byted_acrawler: { frontierSign() {} },
          __sdkN: { u: { 995: { v: () => "verified-bogus" } } },
        },
        fetch: async () => {
          await controls.beforeFetch?.(identity);
          assert.equal(context.closed, false, "fetch context closed in flight");
          return {
            status: 200,
            headers: { get: () => "text/html" },
            text: async () => `<html>identity-${identity}</html>`,
          };
        },
      });
      const page = {
        on() {},
        async setUserAgent() {},
        async setViewport() {},
        async evaluateOnNewDocument() {},
        async setRequestInterception() {},
        async goto() {
          await controls.beforeNavigate?.(identity);
        },
        async reload() {},
        async cookies() {
          return [
            { name: "ttwid", value: `ttwid-${identity}` },
            {
              name: "msToken",
              value: controls.tokens[identity] || `token-${identity}`,
            },
          ];
        },
        async evaluate(fn, arg) {
          if (String(fn).includes("window.__sdkN")) {
            await controls.beforeSign?.(arg, identity);
            if (controls.failedSignatures > 0) {
              controls.failedSignatures--;
              return { error: "SDK not ready" };
            }
          }
          assert.equal(context.closed, false, "operation used a retired context");
          browserGlobals.argument = arg;
          return vm.runInContext(`(${fn.toString()})(argument)`, browserGlobals);
        },
      };
      context.newPage = async () => page;
      return context;
    },
  };
  const globals = vm.createContext({
    URL,
    Date: class extends Date {
      static now() {
        return controls.now;
      }
    },
    console: { log() {}, error() {} },
    process: {
      env: {
        IDENTITY_POOL_SIZE: String(poolSize),
        REPORT_MIN_AGE_MS: "-1",
        ...env,
      },
      on() {},
    },
    setTimeout: (callback, delay) =>
      delay <= 3000
        ? (queueMicrotask(callback), 0)
        : setTimeout(callback, delay),
    clearTimeout,
  });
  const mocks = {
    http: {
      createServer(fn) {
        handler = fn;
        return { listen() {} };
      },
    },
    "puppeteer-extra": { use() {}, launch: async () => browser },
    "puppeteer-extra-plugin-stealth": () => ({}),
  };
  const module = new vm.SourceTextModule(fs.readFileSync(serverUrl, "utf8"), {
    context: globals,
    initializeImportMeta(meta) {
      meta.url = serverUrl.href;
    },
  });
  await module.link(async (specifier) => {
    const imported = Object.hasOwn(mocks, specifier)
      ? { default: mocks[specifier] }
      : await import(
          specifier.startsWith(".")
            ? new URL(specifier, serverUrl).href
            : specifier
        );
    return new vm.SyntheticModule(
      Object.keys(imported),
      function () {
        for (const [key, value] of Object.entries(imported)) {
          this.setExport(key, value);
        }
      },
      { context: globals },
    );
  });
  await module.evaluate();
  async function request(url, body, method = body ? "POST" : "GET") {
    let status;
    let result;
    const headers = {};
    await handler(
      {
        url,
        method,
        async *[Symbol.asyncIterator]() {
          if (body) yield JSON.stringify(body);
        },
      },
      {
        setHeader(name, value) {
          headers[name] = value;
        },
        writeHead(code) {
          status = code;
        },
        end(value) {
          result = JSON.parse(value);
        },
      },
    );
    return { status, headers, body: result };
  }
  return { request, contexts, controls };
}

async function waitForPool(h) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const health = await h.request("/health");
    if (health.body.readyIdentities === health.body.poolSize) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("background pool warm-up did not finish");
}

test("pool verifies signatures without charging the budget, rotates identities, and fetches HTML with matching cookies", async () => {
  const h = await harness();
  await h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  await waitForPool(h);
  const first = await h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  const second = await h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.body.data.identity, second.body.data.identity);
  const health = await h.request("/health");
  assert.equal(health.body.readyIdentities, 2);
  assert.equal(health.body.generationCount, 3);
  assert.ok(health.body.lastSignatureVerificationTime);
  const owner = second.body.data.identity;
  const fetched = await h.request("/fetch", {
    url: `https://www.tiktok.com/@example?msToken=token-${owner}`,
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.contentType, "text/html");
  assert.equal(fetched.body.data, null);
  assert.equal(fetched.body.text, `<html>identity-${owner}</html>`);
});

test("signature responses preserve the documented navigator fields across identities", async () => {
  const h = await harness();
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  await waitForPool(h);
  const health = await h.request("/health");
  const owners = new Set();
  for (let i = 0; i < 2; i++) {
    const signed = await h.request("/signature", {
      url: "https://www.tiktok.com/api/example/",
    });
    assert.equal(signed.status, 200);
    owners.add(signed.body.data.identity);
    assert.deepEqual(signed.body.data.navigator, {
      user_agent: health.body.userAgent,
      platform: "MacIntel",
      browser_language: "en-US",
      os: "mac",
      screen_width: "1920",
      screen_height: "1080",
    });
  }
  assert.equal(owners.size, 2);
});

test("failed verification discards the identity and a later request retries", async () => {
  const h = await harness({ poolSize: 1, failedSignatures: 1 });
  const failed = await h.request("/restart");
  assert.equal(failed.status, 503);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].closed, true);
  assert.equal((await h.request("/health")).body.ready, false);
  const recovered = await h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  assert.equal(recovered.status, 200);
  assert.equal(h.contexts.length, 2);
});

test("restart shares the transition, drains background creation, and has no cooldown", async () => {
  const h = await harness();
  const background = deferred();
  const entered = deferred();
  h.controls.beforeNavigate = async (identity) => {
    if (identity === 2) {
      entered.resolve();
      await background.promise;
    }
  };
  await h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  await entered.promise;
  const first = h.request("/restart");
  const second = h.request("/restart", null, "POST");
  const fetch = h.request("/fetch", { url: "https://www.tiktok.com/@example" });
  background.resolve();
  const responses = await Promise.all([first, second, fetch]);
  assert.ok(responses.every((response) => response.status === 200));
  await waitForPool(h);
  assert.equal(h.contexts.length, 4);
  assert.ok(h.contexts.slice(0, 2).every((context) => context.closed));
  assert.equal(h.contexts.filter((context) => !context.closed).length, 2);
  assert.match(responses[2].body.text, /identity-[34]/);
  assert.equal((await h.request("/restart")).status, 200);
  await waitForPool(h);
  assert.equal(h.contexts.length, 6);
});

test("reports remove the identity from selection but let active signing finish", async () => {
  const h = await harness();
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  await waitForPool(h);
  const gate = deferred();
  const entered = deferred();
  h.controls.beforeSign = async (url) => {
    if (url.includes("blocked=true")) {
      entered.resolve();
      await gate.promise;
    }
  };
  const signing = h.request("/signature", {
    url: "https://www.tiktok.com/api/example/?blocked=true",
  });
  await entered.promise;
  const report = await h.request("/report", { msToken: "token-2" });
  assert.equal(report.body.action, "retired");
  assert.equal(h.contexts[1].closed, false);
  const health = await h.request("/health");
  assert.ok(health.body.identities.every((identity) => identity.id !== 2));
  gate.resolve();
  assert.equal((await signing).status, 200);
  await waitForPool(h);
  assert.equal(h.contexts[1].closed, true);
});

test("a slow fetch does not block signing on another identity", async () => {
  const h = await harness();
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  await waitForPool(h);
  const gate = deferred();
  const entered = deferred();
  h.controls.beforeFetch = async (identity) => {
    assert.equal(identity, 1);
    entered.resolve();
    await gate.promise;
  };
  const fetch = h.request("/fetch", {
    url: "https://www.tiktok.com/@example?msToken=token-1",
  });
  await entered.promise;
  try {
    const signed = await withDeadline(
      h.request("/signature", {
        url: "https://www.tiktok.com/api/example/",
      }),
    );
    assert.equal(signed.status, 200);
    assert.equal(signed.body.data.identity, 2);
  } finally {
    gate.resolve();
    assert.equal((await fetch).status, 200);
  }
});

test("busy round-robin candidate does not block later signatures on an idle identity", async () => {
  const h = await harness();
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  await waitForPool(h);
  const gate = deferred();
  const entered = deferred();
  h.controls.beforeFetch = async (identity) => {
    assert.equal(identity, 2);
    entered.resolve();
    await gate.promise;
  };
  const fetch = h.request("/fetch", {
    url: "https://www.tiktok.com/@example?msToken=token-2",
  });
  await entered.promise;
  const signatures = [1, 2].map(() =>
    h.request("/signature", {
      url: "https://www.tiktok.com/api/example/",
    }),
  );
  try {
    const results = await withDeadline(Promise.all(signatures));
    assert.ok(results.every((result) => result.status === 200));
    assert.ok(results.every((result) => result.body.data.identity === 1));
  } finally {
    gate.resolve();
    await Promise.all([fetch, ...signatures]);
  }
});

for (const reason of ["signature budget", "age"]) {
  test(`retirement by ${reason} does not wait for an active fetch or replacement when another identity is ready`, async () => {
    const h = await harness({
      env:
        reason === "signature budget"
          ? { MAX_GENERATIONS_BEFORE_REFRESH: "1" }
          : { MAX_SESSION_AGE_MS: "1000" },
    });
    const secondIdentity = deferred();
    h.controls.beforeNavigate = async (identity) => {
      if (identity === 2) await secondIdentity.promise;
    };
    await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
    if (reason === "age") h.controls.now += 2000;
    secondIdentity.resolve();
    await waitForPool(h);

    const gate = deferred();
    const entered = deferred();
    const replacement = deferred();
    h.controls.beforeNavigate = async (identity) => {
      if (identity >= 3) await replacement.promise;
    };
    h.controls.beforeFetch = async (identity) => {
      assert.equal(identity, 1);
      entered.resolve();
      await gate.promise;
    };
    const fetch = h.request("/fetch", {
      url: "https://www.tiktok.com/@example?msToken=token-1",
    });
    await entered.promise;
    const signing = h.request("/signature", {
      url: "https://www.tiktok.com/api/example/",
    });
    try {
      const result = await withDeadline(signing);
      assert.equal(result.status, 200);
      assert.equal(result.body.data.identity, 2);
      assert.equal(h.contexts[0].closed, false);
      const health = await h.request("/health");
      assert.ok(health.body.identities.every((identity) => identity.id !== 1));
    } finally {
      gate.resolve();
      replacement.resolve();
      await Promise.all([fetch, signing]);
      await waitForPool(h);
    }
    assert.equal(h.contexts[0].closed, true);
  });
}

test("signing waits for a fetch on the same identity", async () => {
  const h = await harness({ poolSize: 1 });
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  const gate = deferred();
  const entered = deferred();
  let signingStarted = false;
  h.controls.beforeFetch = async () => {
    entered.resolve();
    await gate.promise;
  };
  h.controls.beforeSign = async () => {
    signingStarted = true;
  };
  const fetch = h.request("/fetch", { url: "https://www.tiktok.com/@example" });
  await entered.promise;
  const signing = h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signingStarted, false);
  gate.resolve();
  const results = await Promise.all([fetch, signing]);
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(signingStarted, true);
});

test("restart waits for an active fetch before closing its context", async () => {
  const h = await harness({ poolSize: 1 });
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  const gate = deferred();
  const entered = deferred();
  h.controls.beforeFetch = async () => {
    entered.resolve();
    await gate.promise;
  };
  const fetch = h.request("/fetch", { url: "https://www.tiktok.com/@example" });
  await entered.promise;
  const restart = h.request("/restart");
  const next = h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.contexts[0].closed, false);
  gate.resolve();
  const responses = await Promise.all([fetch, restart, next]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(h.contexts[0].closed, true);
  assert.equal(responses[2].body.data.identity, 2);
});

test("fetch rejects signed URLs whose token rotated, is missing, or is unknown", async () => {
  const h = await harness();
  const first = await h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  await waitForPool(h);
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  h.controls.tokens[1] = "refreshed-token-1";
  const refreshed = await h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  let fetches = 0;
  h.controls.beforeFetch = () => {
    fetches++;
  };
  for (const url of [
    first.body.data.signed_url,
    "https://www.tiktok.com/api/example/?X-Bogus=signature",
    "https://www.tiktok.com/api/example/?X-Gnarly=signature&msToken=unknown",
    "https://www.tiktok.com/api/example/?msToken=unknown",
  ]) {
    const result = await h.request("/fetch", { url });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /new signature/i);
  }
  assert.equal(fetches, 0);
  const current = await h.request("/fetch", {
    url: refreshed.body.data.signed_url,
  });
  assert.equal(current.status, 200);
  assert.equal(current.body.text, "<html>identity-1</html>");
  await h.request("/restart");
  const stale = await h.request("/fetch", {
    url: refreshed.body.data.signed_url,
  });
  assert.equal(stale.status, 409);
  assert.equal(fetches, 1);
});

test("fetch rechecks its token after waiting for an operation on its owner", async () => {
  const h = await harness({ poolSize: 1 });
  const first = await h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  const gate = deferred();
  const entered = deferred();
  h.controls.beforeSign = async () => {
    entered.resolve();
    await gate.promise;
    h.controls.tokens[1] = "rotated-token";
  };
  const signing = h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  await entered.promise;
  let fetches = 0;
  h.controls.beforeFetch = () => {
    fetches++;
  };
  const fetch = h.request("/fetch", { url: first.body.data.signed_url });
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  assert.equal((await signing).status, 200);
  assert.equal((await fetch).status, 409);
  assert.equal(fetches, 0);
});

test("when every identity is busy, signatures resume on whichever becomes idle", async () => {
  const h = await harness();
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  await waitForPool(h);
  const gates = [deferred(), deferred()];
  const entered = [deferred(), deferred()];
  h.controls.beforeFetch = async (identity) => {
    entered[identity - 1].resolve();
    await gates[identity - 1].promise;
  };
  const fetches = [1, 2].map((id) =>
    h.request("/fetch", {
      url: `https://www.tiktok.com/@example?msToken=token-${id}`,
    }),
  );
  await Promise.all(entered.map((entry) => entry.promise));
  const signatures = [1, 2].map(() =>
    h.request("/signature", {
      url: "https://www.tiktok.com/api/example/",
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  gates[0].resolve();
  try {
    const results = await withDeadline(Promise.all(signatures));
    assert.ok(results.every((result) => result.status === 200));
    assert.ok(results.every((result) => result.body.data.identity === 1));
  } finally {
    gates[1].resolve();
    await Promise.all([...fetches, ...signatures]);
  }
});

test("an identity added in the background wakes a waiting signature", async () => {
  const h = await harness();
  const background = deferred();
  h.controls.beforeNavigate = async (identity) => {
    if (identity === 2) await background.promise;
  };
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  const gate = deferred();
  const entered = deferred();
  h.controls.beforeFetch = async () => {
    entered.resolve();
    await gate.promise;
  };
  const fetch = h.request("/fetch", {
    url: "https://www.tiktok.com/@example?msToken=token-1",
  });
  await entered.promise;
  const signing = h.request("/signature", {
    url: "https://www.tiktok.com/api/example/",
  });
  await new Promise((resolve) => setImmediate(resolve));
  background.resolve();
  try {
    const result = await withDeadline(signing);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.identity, 2);
  } finally {
    gate.resolve();
    await Promise.all([fetch, signing]);
  }
});

test("concurrent fetch and signature waiters reserve different available identities", async () => {
  const h = await harness();
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  await waitForPool(h);
  const gates = [deferred(), deferred(), deferred()];
  const entered = [deferred(), deferred(), deferred()];
  let firstIdentityFetches = 0;
  h.controls.beforeFetch = async (identity) => {
    const index = identity === 2 ? 1 : firstIdentityFetches++ === 0 ? 0 : 2;
    entered[index].resolve();
    await gates[index].promise;
  };
  const pinnedFetches = [1, 2].map((identity) =>
    h.request("/fetch", {
      url: `https://www.tiktok.com/@example?msToken=token-${identity}`,
    }),
  );
  await withDeadline(Promise.all(entered.slice(0, 2).map((x) => x.promise)));
  const unsignedFetch = h.request("/fetch", {
    url: "https://www.tiktok.com/@example",
  });
  const signatures = [1, 2].map(() =>
    h.request("/signature", { url: "https://www.tiktok.com/api/example/" }),
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    gates[0].resolve();
    // The unsigned fetch takes identity 1 and remains active on it.
    await withDeadline(entered[2].promise);
    gates[1].resolve();
    await pinnedFetches[1];
    const results = await withDeadline(Promise.all(signatures));
    assert.ok(results.every((result) => result.status === 200));
    assert.ok(results.every((result) => result.body.data.identity === 2));
  } finally {
    gates.forEach((gate) => gate.resolve());
    await Promise.all([...pinnedFetches, unsignedFetch, ...signatures]);
  }
});

test("a failed reserved signature retries on another identity and releases its reservation", async () => {
  const h = await harness({ poolSize: 1 });
  await h.request("/signature", { url: "https://www.tiktok.com/api/example/" });
  h.controls.failedSignatures = 1;
  const retried = await withDeadline(
    h.request("/signature", { url: "https://www.tiktok.com/api/example/" }),
  );
  assert.equal(retried.status, 200);
  assert.equal(retried.body.data.identity, 2);
  assert.equal(h.contexts[0].closed, true);
  const next = await withDeadline(
    h.request("/signature", { url: "https://www.tiktok.com/api/example/" }),
  );
  assert.equal(next.status, 200);
  assert.equal(next.body.data.identity, 2);
});

async function withDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation blocked")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
