# Instagram Influencer Analyzer

Instagram 계정 목록을 입력하면 팔로워, 최근 게시물 반응, 참여율을 수집해 보여주는 Node.js/Express 기반 분석 도구입니다.

## Requirements

- Node.js 18 이상
- Instagram 로그인 계정
- Chrome 또는 Puppeteer가 설치한 Chrome

## Setup

```bash
npm install
cp .env.example .env
```

`.env`에 Instagram 로그인 정보를 입력합니다.

```env
IG_USERNAME=your_instagram_username
IG_PASSWORD=your_instagram_password
PORT=3000
HEADLESS=true
```

Puppeteer용 Chrome이 없으면 아래 명령으로 설치합니다.

```bash
npm run install-browser
```

로컬 Chrome을 직접 쓰려면 `.env`에 경로를 지정할 수 있습니다.

```env
PUPPETEER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

## Run

```bash
npm start
```

브라우저에서 `http://localhost:3000`을 열어 사용합니다.

## Security

`.env`, `.puppeteer-profile`, `node_modules`는 Git에 포함하지 않습니다. 실제 Instagram 계정 정보는 GitHub에 올리지 말고, `.env.example`만 공유하세요.
