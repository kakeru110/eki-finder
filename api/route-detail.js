// Vercel serverless function. 駅すぱあとAPIの「経路簡易探索(course)」を中継し、
// 2駅間の実際の経路(乗換駅・路線名・区間ごとの所要時間)を返す。
// 範囲探索(multi-range.js)は所要時間の集計しか返さないため、
// 結果の「詳細を見る」クリック時にこちらを個別に叩いて詳細を取得する。
//
// GET /api/route-detail?from=渋谷&to=品川
//
// レスポンス: {
//   from, to, transferCount, totalMinutes,
//   legs: [{ from, to, line, destination, minutes, departureTime, arrivalTime }]
// }
//
// 買い切り型プランの経路探索は「平均待ち時間ベース」で時刻表アクセスがないため、
// departureTime/arrivalTimeは取得できないことがある(その場合はnull)。
// minutes(区間所要時間)と路線名・乗換駅は概算ベースでも返る想定。

const KANTO_PREFS = ["東京都", "神奈川県", "埼玉県", "千葉県"];
const MAX_RETRIES = 8;

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

  const from = (req.query.from || "").trim();
  const to = (req.query.to || "").trim();
  if (!from || !to) {
    res.status(400).json({ error: "from, to は必須です" });
    return;
  }

  let resultSet;
  try {
    resultSet = await callCourseWithDisambiguation(apiKey, from, to);
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
    return;
  }

  const courses = toArray(resultSet.Course);
  if (courses.length === 0) {
    res.status(404).json({ error: "経路が見つかりませんでした" });
    return;
  }
  const route = courses[0].Route;
  if (!route) {
    res.status(502).json({ error: "レスポンスに経路情報が含まれていません" });
    return;
  }

  const points = toArray(route.Point);
  const lines = toArray(route.Line);
  const legs = lines.map((line, i) => {
    const fromPt = points[i];
    const toPt = points[i + 1];
    return {
      from: stationName(fromPt),
      to: stationName(toPt),
      line: textOf(line.Name) || "",
      destination: textOf(line.Destination),
      minutes: line.timeOnBoard != null ? Number(line.timeOnBoard) : null,
      departureTime: extractClock(line.DepartureState),
      arrivalTime: extractClock(line.ArrivalState),
    };
  });

  res.status(200).json({
    from,
    to,
    transferCount: route.transferCount != null ? Number(route.transferCount) : null,
    totalMinutes: sumMinutes(route),
    legs,
  });
};

// from/toのいずれかがE102(駅名が見つかりません)で失敗したら、その駅名に
// 都道府県修飾子を順番に付けてリトライする(multi-range.jsと同じ考え方)。
async function callCourseWithDisambiguation(apiKey, from, to) {
  let f = from, t = to;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const data = await callCourse(apiKey, f, t);
    const err = data && data.ResultSet && data.ResultSet.Error;
    if (!err) return data.ResultSet;

    if (err.code === "E102") {
      const match = /\(([^)]+)\)\s*$/.exec(err.Message || "");
      const failingName = match ? match[1] : null;
      if (failingName === f) {
        const next = nextQualifier(f);
        if (!next) throw new Error(`駅名を解決できませんでした: ${f}`);
        f = next;
      } else if (failingName === t) {
        const next = nextQualifier(t);
        if (!next) throw new Error(`駅名を解決できませんでした: ${t}`);
        t = next;
      } else {
        throw new Error(`ekispert API error ${err.code}: ${err.Message}`);
      }
      continue;
    }
    throw new Error(`ekispert API error ${err.code}: ${err.Message}`);
  }
  throw new Error("駅名解決の再試行回数が上限に達しました");
}

function nextQualifier(name) {
  const m = /\(([^)]+)\)$/.exec(name);
  const base = m ? name.slice(0, m.index) : name;
  const idx = m ? KANTO_PREFS.indexOf(m[1]) + 1 : 0;
  if (idx >= KANTO_PREFS.length) return null;
  return `${base}(${KANTO_PREFS[idx]})`;
}

async function callCourse(apiKey, from, to) {
  const url =
    `https://api.ekispert.jp/v1/json/search/course` +
    `?key=${encodeURIComponent(apiKey)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&plane=false&shinkansen=false&answerCount=1`;

  let r;
  try {
    r = await fetch(url);
  } catch (err) {
    throw new Error(`ekispert APIに接続できませんでした: ${err}`);
  }
  const data = await r.json().catch(() => null);
  if (!data || !data.ResultSet) {
    throw new Error(`ekispert APIの応答が不正です(HTTP ${r.status})`);
  }
  return data;
}

function stationName(point) {
  return (point && point.Station && textOf(point.Station.Name)) || "";
}
// 駅すぱあとのXML→JSON変換は「属性+テキスト」を持つ要素(例: <Type detail="x">train</Type>)を
// { detail: "x", "#text": "train" } のような形にする想定。文字列ならそのまま、
// オブジェクトなら "#text" 等のキーを試す(未知の形でもクラッシュしないよう防御的に)。
function textOf(node) {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    return node["#text"] ?? node._ ?? node.$text ?? null;
  }
  return null;
}
function extractClock(state) {
  const iso = state && textOf(state.Datetime);
  if (!iso) return null;
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : null;
}
function sumMinutes(route) {
  const on = Number(route.timeOnBoard) || 0;
  const walk = Number(route.timeWalk) || 0;
  const other = Number(route.timeOther) || 0;
  return on + walk + other;
}
function toArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}
