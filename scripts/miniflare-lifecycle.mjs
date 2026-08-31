const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_RESTART_SETTLE_MS = 500;

function timeoutAfter(timeoutMs, value) {
    let timer;
    const promise = new Promise(resolvePromise => {
        timer = setTimeout(() => resolvePromise(value), timeoutMs);
    });
    return { promise, cancel: () => clearTimeout(timer) };
}

function assertTimeout(timeoutMs, name) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`${name} must be a positive finite number`);
    }
}

function assertDelay(delayMs, name) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error(`${name} must be a non-negative finite number`);
    }
}

export async function disposeMiniflareBounded(
    instance,
    {
        timeoutMs = DEFAULT_DISPOSE_TIMEOUT_MS,
        label = "Miniflare",
        diagnose = console.warn,
        onTimeout = () => undefined,
    } = {}
) {
    if (!instance) return { status: "absent" };
    assertTimeout(timeoutMs, "Miniflare dispose timeout");

    const timeout = timeoutAfter(timeoutMs, { status: "timed-out" });
    const disposal = Promise.resolve()
        .then(() => instance.dispose())
        .then(
            () => ({ status: "disposed" }),
            error => ({ status: "rejected", error })
        );
    const result = await Promise.race([disposal, timeout.promise]);
    timeout.cancel();

    if (result.status === "timed-out") {
        onTimeout();
        diagnose(`${label} disposal exceeded ${timeoutMs}ms; continuing after the deadline`);
    } else if (result.status === "rejected") {
        diagnose(`${label} disposal rejected; continuing because the instance is no longer usable`, result.error);
    }
    return result;
}

export async function restartMiniflareBounded(
    current,
    start,
    {
        disposeTimeoutMs = DEFAULT_DISPOSE_TIMEOUT_MS,
        readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
        settleDelayMs = DEFAULT_RESTART_SETTLE_MS,
        label = "Miniflare restart",
        diagnose = console.warn,
        onDisposeTimeout = () => undefined,
    } = {}
) {
    assertTimeout(readyTimeoutMs, "Miniflare ready timeout");
    assertDelay(settleDelayMs, "Miniflare restart settle delay");
    const disposal = await disposeMiniflareBounded(current, {
        timeoutMs: disposeTimeoutMs,
        label: `${label} teardown`,
        diagnose,
        onTimeout: onDisposeTimeout,
    });
    if (settleDelayMs > 0) await Bun.sleep(settleDelayMs);
    const instance = start();
    const timeout = timeoutAfter(readyTimeoutMs, { status: "timed-out" });
    const ready = instance.ready.then(
        origin => ({ status: "ready", origin }),
        error => ({ status: "rejected", error })
    );
    const result = await Promise.race([ready, timeout.promise]);
    timeout.cancel();
    if (result.status !== "ready") {
        await disposeMiniflareBounded(instance, {
            timeoutMs: disposeTimeoutMs,
            label: `${label} failed-start cleanup`,
            diagnose,
            onTimeout: onDisposeTimeout,
        });
        if (result.status === "rejected") throw result.error;
        throw new Error(`${label} did not become ready within ${readyTimeoutMs}ms`);
    }
    return { instance, origin: result.origin, disposal };
}
