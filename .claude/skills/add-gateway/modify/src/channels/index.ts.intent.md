# Intent: Add Gateway channel import

Add `import './gateway.js';` to the channel barrel file so the Gateway
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
