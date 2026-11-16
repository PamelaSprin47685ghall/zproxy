import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUnpausedProviders, providerPauseReason, setUnpausedProviders } from "@oh-my-pi/pi-ai/oauth";
import { acquireProviderOptIn } from "./remote-opt-in.mjs";
import { createRemoteGateway } from "./remote.mjs";

const PROVIDER = "google-antigravity";

test("provider opt-in leases preserve existing choices and return detached snapshots", () => {
  const previous = getUnpausedProviders();
  let release;
  try {
    setUnpausedProviders(["fixture-existing", PROVIDER]);
    const copy = getUnpausedProviders();
    copy.clear();
    expect(getUnpausedProviders().has(PROVIDER)).toBe(true);
    release = acquireProviderOptIn(PROVIDER);
    release();
    release();
    expect([...getUnpausedProviders()]).toEqual(["fixture-existing", PROVIDER]);
  } finally { release?.(); setUnpausedProviders(previous); }
});

test("enabled gateways share opt-in while disabled gateways and shutdown preserve other choices", async () => {
  const previous = getUnpausedProviders();
  const directory = await mkdtemp(join(tmpdir(), "zproxy-opt-in-"));
  const gateways = [];
  let workerCloses = 0;
  try {
    setUnpausedProviders(["fixture-existing"]);
    const modelsFile = join(directory, "models.yml");
    await writeFile(modelsFile, "{\"providers\":{}}");
    const create = async (name, enabled, routingFactory) => {
      const gateway = await createRemoteGateway({ version: 1, antigravity2api: enabled,
        authDatabase: join(directory, `${name}.db`), modelCache: join(directory, `${name}-models.db`), modelsFile, discovery: "offline" }, {
        fetch: () => { throw new Error("No fixture upstream is configured."); }, routingFactory,
        agWorker: { prepare() { throw new Error("No fixture codec request is configured."); }, async close() { workerCloses++; } },
      });
      gateways.push(gateway);
      return gateway;
    };
    const disabled = await create("disabled", false);
    expect(providerPauseReason(PROVIDER)).toBeDefined();
    await disabled.close();
    expect([...getUnpausedProviders()]).toEqual(["fixture-existing"]);
    const first = await create("first", true);
    const second = await create("second", true);
    expect(providerPauseReason(PROVIDER)).toBeUndefined();
    setUnpausedProviders([...getUnpausedProviders(), "fixture-added-later"]);
    await first.close();
    await first.close();
    expect(getUnpausedProviders().has(PROVIDER)).toBe(true);
    await second.close();
    expect([...getUnpausedProviders()]).toEqual(["fixture-existing", "fixture-added-later"]);
    expect(workerCloses).toBe(2);
    await expect(create("failed", true, () => { throw new Error("Fixture initialization failed."); })).rejects.toThrow("Fixture initialization failed");
    expect([...getUnpausedProviders()]).toEqual(["fixture-existing", "fixture-added-later"]);
    expect(workerCloses).toBe(3);
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "fixture");
    await expect(createRemoteGateway({ version: 1, antigravity2api: true,
      authDatabase: join(blocked, "auth.db"), discovery: "offline" })).rejects.toThrow();
    expect([...getUnpausedProviders()]).toEqual(["fixture-existing", "fixture-added-later"]);
  } finally {
    await Promise.allSettled(gateways.map(gateway => gateway.close()));
    setUnpausedProviders(previous);
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
