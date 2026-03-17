FROM node:22-bookworm-slim

WORKDIR /app

# Create data directory for SQLite (since it's in .dockerignore)
RUN mkdir -p /app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Ensure data directory exists and is writable
RUN mkdir -p /app/data && chmod 755 /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
