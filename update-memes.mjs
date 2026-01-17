const DISCOVERY_PATH = process.env.DISCOVERY_PATH || "latest_ids.json";

async function getTopIdsFromDiscovery() {
  const raw = await fs.readFile(DISCOVERY_PATH, "utf8"); // throws if missing
  const j = JSON.parse(raw);

  // Support a few shapes in case you later change worker payload
  const idsRaw =
    Array.isArray(j?.ids) ? j.ids :
    Array.isArray(j?.latest_ids) ? j.latest_ids :
    Array.isArray(j) ? j :
    [];

  const ids = idsRaw.map(x => String(x).trim()).filter(Boolean);

  if (ids.length < TOP_N) {
    die(`Discovery required: ${DISCOVERY_PATH} has ${ids.length} IDs (need ${TOP_N}).`);
  }

  return ids.slice(0, TOP_N);
}
