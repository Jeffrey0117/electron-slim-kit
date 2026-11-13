---
name: electron-slim-kit
description: Electron app 的安裝檔太大、要發版前想瘦身，或看到 app.asar 裡塞了一堆 node_modules 時使用。找出「畫面已經打包、卻又整份複製進安裝檔」的套件，給出最小修改，並在重新打包後驗證。
---

# electron-slim-kit — 打法

**Electron 安裝檔會把 `dependencies` 裡每個套件整份帶上，不管執行時有沒有人載入。畫面那邊的套件（react 之類）已經被 vite/esbuild 打包進去了，寫在 `dependencies` 就是白帶第二份。**

## 何時觸發

- 使用者嫌 Electron 安裝檔 / 自動更新包太大
- 發版前的例行檢查
- 看到 `app.asar` 幾十 MB、裡面一堆 `node_modules`
- 新開 Electron 專案、第一次設定打包時（一開始就分對 dependencies / devDependencies）

## 接線（照抄能跑）

```bash
npx github:Jeffrey0117/electron-slim-kit audit <專案>        # 1. 看多帶了什麼
npx github:Jeffrey0117/electron-slim-kit fix <專案>          # 2. 看要改什麼（不寫入）
npx github:Jeffrey0117/electron-slim-kit fix <專案> --write  # 3. 套用
# 4. 照平常方式打包（electron-builder --dir 最快）
npx github:Jeffrey0117/electron-slim-kit verify <專案>       # 5. 檢查打包結果，不對會 exit 1
# 6. 實際開一次 app
```

第 6 步不能省。`verify` 只證明打包檔內容對，不證明每條程式路徑都跑得到。

## 模式

兩種修法，kit 會自己選：

| 主程式的狀況 | 修法 |
|---|---|
| 完全不從 `node_modules` 載入（主程式是 esbuild/vite 打成的單一檔） | `build.files` 加 `"!node_modules/**/*"`，`build.npmRebuild: false` |
| 要載入一部分（主程式沒打包，例如 `electron/main.cjs` 直接 `require('sharp')`） | 把其他的從 `dependencies` 搬到 `devDependencies` |

另外還有一種跟套件無關、會疊加在上面的修法：

| 狀況 | 修法 |
|---|---|
| 打包輸出的資料夾本身被 `build.files` 包進去（vite 跟 electron-builder 都寫到 `dist/`） | `build.directories.output` 改到沒人包的資料夾（預設 `release`），刪掉舊的輸出資料夾、新的加進 `.gitignore` |

這種情況每次打包都會把「上一次的打包結果」整個塞進 `app.asar`（實案：268MB → 0.2MB）。`verify` 看到打包檔裡有 `win-unpacked/` 或巢狀的 `app.asar` 會直接判失敗。

判斷依據是「從主程式入口沿著 require/import 走，實際走得到哪些套件」，不是掃資料夾。preload 會自動跟進去。

回報給使用者時講三個數字就好：打包檔前後大小、少帶幾個套件、app 開起來有沒有正常。

## 地雷

- **主程式是 build 產物就要先 build**。kit 讀的是實際會出貨的檔案，沒 build 會直接報錯而不是用原始碼猜——套件有沒有被 bundler 包進去，正是要回答的問題。
- **`node_modules` 沒跟上 package.json 時，打包工具會默默漏掉沒裝的套件**（實案：ReVid 的 `opencc-js` 加進 package.json 後本機沒重裝，打出來的 app 少了它，vite build 也因為另一個沒裝的套件失敗、用的是舊的 `dist`）。`audit` 看到「not installed here」就先 `npm install` 再打包。
- **修完要從乾淨狀態重打**：改了輸出資料夾之後，舊的輸出資料夾要先刪，不然還是會被包進去。
- **`fix --write` 會重排 package.json**：縮排、換行、結尾換行都保留，但寫成一行的物件會被展開，diff 會比實際改動大。
- **專案有未 commit 的改動就先別動**（尤其是 package.json 本身已經被改過），跟使用者確認。
- **`dynamicLoads` 不是 0 就要人工看**。`require(變數)` 掃不到；外掛系統、依平台載入原生模組最常見。
- **用路徑字串啟動的東西要加 `--entry`**：worker、utility process、`fork('…/cli.js')`。漏了會把它需要的套件當成沒人用。
- **同一個 repo 也被當成網站部署時，先確認部署那邊安裝時有沒有帶 devDependencies**。搬到 devDependencies 之後，如果部署用 `npm ci --omit=dev` 或 `NODE_ENV=production npm install`，網站的 build 會找不到 react。（CloudPipe 是用 `NODE_ENV=development` 安裝，沒這個問題。）
- **別在正式服務的部署目錄裡打包驗證**，另外 clone 一份。
- **`verify` 說「transitive package not packed」通常不是問題**：打包工具本來就會剔掉純型別套件和其他平台的 binary。只有「loaded by the main process but not packed」才是真的會壞。
- **舊的打包輸出會誤導**：`verify` 預設抓 `release/`、`dist/`、`out/` 底下最新的 `app.asar`。改完要重新打包再驗，不然驗到的是上次的。
- **搬到 devDependencies 不會讓 app 變慢或變小以外的任何事**，但自動更新的差分包會因為 `app.asar` 內容大改而變大一次。
- 這類規則沒辦法用一行 regex 判斷，所以沒有 `kit-checks.json`；`electron-slim audit` 本身就是檢查。
