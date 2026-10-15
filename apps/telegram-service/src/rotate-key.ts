/**
 * Re-encrypts the session vault under a new key.
 *   SESSION_ENCRYPTION_KEY=<old> SESSION_ENCRYPTION_KEY_NEW=<new> npm run rotate-key -w @telestream/telegram-service
 * Afterwards set SESSION_ENCRYPTION_KEY to the new value and restart the service.
 */
import { loadConfig } from "./config";
import { parseKey, SessionVault } from "./vault";

const cfg = loadConfig();
const oldKey = parseKey(cfg.SESSION_ENCRYPTION_KEY);
const newKey = parseKey(process.env.SESSION_ENCRYPTION_KEY_NEW, "SESSION_ENCRYPTION_KEY_NEW");

const session = await new SessionVault(cfg.SESSION_FILE, oldKey).load();
if (!session) {
  console.error("No session vault found; nothing to rotate.");
  process.exit(1);
}
await new SessionVault(cfg.SESSION_FILE, newKey).save(session);
console.log("Vault re-encrypted. Now set SESSION_ENCRYPTION_KEY to the new key and restart.");
