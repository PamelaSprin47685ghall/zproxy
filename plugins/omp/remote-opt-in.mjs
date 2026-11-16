// Share the official opt-in across gateways in this process.
import { getUnpausedProviders, setUnpausedProviders } from "@oh-my-pi/pi-ai/oauth";

const leases = new Map();

export function acquireProviderOptIn(provider) {
  let lease = leases.get(provider);
  if (!lease) {
    const current = getUnpausedProviders();
    lease = { references: 0, added: !current.has(provider) };
    if (lease.added) setUnpausedProviders([...current, provider]);
    leases.set(provider, lease);
  }
  lease.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lease.references) return;
    leases.delete(provider);
    if (!lease.added) return;
    const current = new Set(getUnpausedProviders());
    current.delete(provider);
    setUnpausedProviders(current);
  };
}
