// 実際の乗換案内API(駅すぱあと/ジョルダン等)に接続するための中継サーバーの雛形。
// APIキーをブラウザに露出させないため、フロントエンドは index.html から直接APIを叩かず
// この中継サーバー経由で問い合わせる想定。現時点では未接続(APIキー未取得)。
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TRANSIT_API_KEY || "";

app.get("/api/route", async (req, res) => {
  if (!API_KEY) {
    return res.status(501).json({
      error: "TRANSIT_API_KEY が未設定です。実APIに接続する際はここで駅すぱあと/ジョルダンAPIへリクエストを中継してください。",
    });
  }
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: "from, to は必須です" });
  }
  // TODO: 実APIへのリクエストをここに実装する
  res.status(501).json({ error: "未実装" });
});

app.listen(PORT, () => {
  console.log(`eki-proxy listening on port ${PORT}`);
});
