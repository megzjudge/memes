const DISCOVERY_PATH = process.env.DISCOVERY_PATH || "latest_ids.json";

async function getTopIdsFromDiscovery() {
  const raw = await fs.readFile(DISCOVERY_PATH, "utf8"); // throws if missing
  const j = JSON.parse(raw);

  const ids = Array.isArray(j.ids) ? j.ids.map(x => String(x).trim()).filter(Boolean) : [];
  if (ids.length < TOP_N) {
    die(`Discovery required: ${DISCOVERY_PATH} has ${ids.length} IDs (need ${TOP_N}).`);
  }
  return ids.slice(0, TOP_N);
}
