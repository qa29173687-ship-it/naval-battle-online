# 海戰棋 Online（v1 基本版）
2–5 人連線大亂鬥海戰棋。8×8 海域、4 艘船（4/3/3/2），每回合 15 秒同時開火，最後有船的人獲勝。

- `game.js`：遊戲邏輯與狀態（之後可接資料庫）
- `server.js`：Node.js + ws，伺服器權威判定，船的位置只存在伺服器
- `public/`：前端（HTML/CSS/JS，手機直式優先）

本機執行：`npm install && npm start`，開 http://localhost:8080
環境變數：`PORT`、`TURN_SECONDS`（預設 15）、`PLACE_SECONDS`（預設 60）

## 一鍵部署到 Render（免費）
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/qa29173687-ship-it/naval-battle-online)
