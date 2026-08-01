import { jest } from "@jest/globals";
import {
  BrowserOperationQueue,
  BrowserOperationTimeoutError,
  RestartCoordinator,
  RestartRateLimitError,
  SingleFlight,
} from "../browser-operations.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BrowserOperationQueue", () => {
  test("uses a 90-second wait timeout by default", () => {
    expect(new BrowserOperationQueue().waitTimeoutMs).toBe(90_000);
  });

  test("processes signature, restart, and fetch operations in FIFO order", async () => {
    const queue = new BrowserOperationQueue({ waitTimeoutMs: 1000 });
    const first = deferred();
    const events = [];

    const signature = queue.enqueue("signature", async () => {
      events.push("signature:start");
      await first.promise;
      events.push("signature:end");
    });
    const restart = queue.enqueue("restart", async () => {
      events.push("restart");
    });
    const fetch = queue.enqueue("fetch", async () => {
      events.push("fetch");
    });

    await Promise.resolve();
    expect(events).toEqual(["signature:start"]);
    first.resolve();
    await Promise.all([signature, restart, fetch]);
    expect(events).toEqual([
      "signature:start",
      "signature:end",
      "restart",
      "fetch",
    ]);
  });

  test("rejects and removes an operation that waits past its timeout", async () => {
    const queue = new BrowserOperationQueue({ waitTimeoutMs: 10 });
    const blocker = deferred();
    const first = queue.enqueue("signature", () => blocker.promise);
    const expiredOperation = jest.fn();
    const expired = queue.enqueue("fetch", expiredOperation);

    await expect(expired).rejects.toBeInstanceOf(BrowserOperationTimeoutError);
    expect(expiredOperation).not.toHaveBeenCalled();
    blocker.resolve();
    await first;
  });
});

describe("SingleFlight", () => {
  test("shares initialization failures and allows a later retry", async () => {
    const flight = new SingleFlight();
    const gate = deferred();
    const initialize = jest.fn(() => gate.promise);

    const first = flight.run(initialize);
    const second = flight.run(initialize);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(initialize).toHaveBeenCalledTimes(1);

    gate.reject(new Error("initialization failed"));
    await Promise.all([
      expect(first).rejects.toThrow("initialization failed"),
      expect(second).rejects.toThrow("initialization failed"),
    ]);

    await expect(flight.run(async () => "ready")).resolves.toBe("ready");
  });
});

describe("RestartCoordinator", () => {
  test("coalesces concurrent restart requests into one operation", async () => {
    const queue = new BrowserOperationQueue({ waitTimeoutMs: 1000 });
    const gate = deferred();
    const restart = jest.fn(() => gate.promise);
    const coordinator = new RestartCoordinator({
      enqueue: (label, operation) => queue.enqueue(label, operation),
      restart,
    });

    const requests = Array.from({ length: 20 }, () => coordinator.request());
    expect(requests[0].coalesced).toBe(false);
    expect(requests.slice(1).every(({ coalesced }) => coalesced)).toBe(true);
    expect(
      requests.every(({ promise }) => promise === requests[0].promise),
    ).toBe(true);
    expect(coordinator.isRestarting).toBe(true);

    gate.resolve();
    await Promise.all(requests.map(({ promise }) => promise));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(coordinator.isRestarting).toBe(false);
  });

  test("enforces the successful restart cooldown", async () => {
    let now = 1000;
    const coordinator = new RestartCoordinator({
      enqueue: (_label, operation) => operation(),
      restart: async () => {},
      cooldownMs: 60_000,
      now: () => now,
    });

    await coordinator.request().promise;
    expect(() => coordinator.request()).toThrow(RestartRateLimitError);
    expect(coordinator.cooldownRemainingSeconds).toBe(60);

    now += 60_000;
    await expect(coordinator.request().promise).resolves.toBeUndefined();
  });

  test("uses a five-second backoff after failure and then retries", async () => {
    let now = 1000;
    const restart = jest
      .fn()
      .mockRejectedValueOnce(new Error("launch failed"))
      .mockResolvedValueOnce();
    const coordinator = new RestartCoordinator({
      enqueue: (_label, operation) => operation(),
      restart,
      failureBackoffMs: 5_000,
      now: () => now,
    });

    const failedRestart = coordinator.request().promise;
    await expect(failedRestart).rejects.toMatchObject({
      message: "launch failed",
      statusCode: 503,
    });
    expect(() => coordinator.request()).toThrow(RestartRateLimitError);
    expect(coordinator.cooldownRemainingSeconds).toBe(5);

    now += 5_000;
    await expect(coordinator.request().promise).resolves.toBeUndefined();
    expect(restart).toHaveBeenCalledTimes(2);
  });
});
