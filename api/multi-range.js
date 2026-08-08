// Vercel serverless function. Keeps EKISPERT_API_KEY server-side and proxies
// requests to 駅すぱあとAPI's multipleRange (範囲探索) endpoint.
//
// GET /api/multi-range?stations=新宿,横浜,町田&minutes=90
//   stations: 2〜8件、カンマ区切りの駅名(職場 or 自宅の最寄駅)
//   minutes:  各駅からの上限所要時間(分, 10〜200)。省略時90分
//
// レスポンス: { stations, upperMinute, candidates: [{ code, name, prefecture, minutesByPerson: [...] }] }
// candidates は stations 全員が upperMinute 以内に到達できる駅のみを含む。
//
// 駅すぱあとのレスポンスはXMLをJSON化したものなので、要素が1件のときは配列でなく
// オブジェクトになる(既知の挙動)。toArray() で必ず配列に正規化して扱う。

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }

  const apiKey = process.env.EKISPERT_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "EKISPERT_API_KEY is not configured on the server" });
    return;
  }

  const stationsParam = req.query.stations;
  if (!stationsParam) {
    res.status(400).json({ error: "stations is required" });
    return;
  }
  const names = String(stationsParam)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length < 2 || names.length > 8) {
    res.status(400).json({ error: "stations must contain 2 to 8 names" });
    return;
  }
  const upperMinute = Math.min(200, Math.max(10, Number(req.query.minutes) || 90));

  const batches = [];
  for (let i = 0; i < names.length; i += 5) batches.push(names.slice(i, i + 5));

  // code -> { code, name, prefecture, minutesByPerson: [人数分, 未到達はnull] }
  const candidates = new Map();
  let globalOffset = 0;

  for (const batch of batches) {
    const baseList = batch.map((n) => encodeURIComponent(n)).join(":");
    const upperMinuteList = batch.map(() => upperMinute).join(":");
    const url =
      `https://api.ekispert.jp/v1/json/search/multipleRange` +
      `?key=${encodeURIComponent(apiKey)}&baseList=${baseList}&upperMinute=${upperMinuteList}` +
      `&plane=false&shinkansen=false`;

    let data;
    try {
      const r = await fetch(url);
      data = await r.json();
      if (!r.ok) {
        res.status(502).json({ error: `ekispert API HTTP ${r.status}`, detail: data });
        return;
      }
    } catch (err) {
      res.status(502).json({ error: "failed to reach ekispert API", detail: String(err) });
      return;
    }

    if (data && data.ResultSet && data.ResultSet.Error) {
      res.status(502).json({ error: "ekispert API error", detail: data.ResultSet.Error });
      return;
    }
    const resultSet = data && data.ResultSet;
    if (!resultSet) {
      res.status(502).json({ error: "unexpected response shape from ekispert API", raw: data });
      return;
    }

    for (const point of toArray(resultSet.Point)) {
      const station = point.Station || {};
      const code = station.code;
      if (!code) continue;
      if (!candidates.has(code)) {
        candidates.set(code, {
          code,
          name: station.Name || "",
          prefecture: (point.Prefecture && point.Prefecture.Name) || "",
          minutesByPerson: new Array(names.length).fill(null),
        });
      }
      const entry = candidates.get(code);
      for (const cost of toArray(point.Cost)) {
        const localIdx = Number(cost.baseIndex) - 1; // baseIndexは1始まり
        if (Number.isNaN(localIdx)) continue;
        const globalIdx = globalOffset + localIdx;
        if (globalIdx >= 0 && globalIdx < names.length) {
          entry.minutesByPerson[globalIdx] = Number(cost.Minute);
        }
      }
    }
    globalOffset += batch.length;
  }

  // 全員が到達できる駅だけを候補として返す
  const full = [...candidates.values()].filter((c) => c.minutesByPerson.every((m) => m !== null));

  res.status(200).json({ stations: names, upperMinute, candidates: full });
}

function toArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

