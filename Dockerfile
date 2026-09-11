# The epub -> PDF server (server/uploadServer.ts) -- not the site.
#
# The site is the Vite build, and Vercel serves that. This is the other
# half: it drives headless Chromium to paginate books, which a serverless
# function cannot host, and it keeps converted books on disk so each one is
# only converted once. So it runs as an ordinary long-lived container, on
# any host that can run a Dockerfile (Railway, Render, Fly.io, a VPS).
#
#   docker build -t athenaeum-server .
#   docker run -p 3000:3000 -e CORS_ORIGINS=http://localhost:5173 athenaeum-server

FROM node:22-bookworm-slim

WORKDIR /app

# Dependencies before code, so editing the server does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Chromium for Playwright, at exactly the version the playwright package just
# installed expects, plus the system libraries and fonts it needs to run.
RUN npx playwright install --with-deps chromium

COPY server ./server
# The shelf: GET /api/library lists the epubs in src/books.
COPY src/books ./src/books

ENV NODE_ENV=production

# Converted books are written to /app/books. Mount a persistent volume there,
# or every restart and redeploy throws the cache away and each book has to be
# converted again the next time someone opens it.

# Hosts usually set PORT themselves; uploadServer.ts reads it, else 3000.
EXPOSE 3000

CMD ["node", "--experimental-strip-types", "server/uploadServer.ts"]
