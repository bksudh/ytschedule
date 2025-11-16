FROM node:18-alpine

# Install FFmpeg (required for video streaming)
RUN apk add --no-cache ffmpeg

# Set working directory
WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package*.json ./

# Install production dependencies
ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source
COPY . .

# Prepare runtime directories and permissions
RUN mkdir -p /app/videos \
    && chown -R node:node /app

# Use non-root user for security
USER node

# Expose service port
EXPOSE 3000

# Health check on /api/health
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "http=require('http'); req=http.request({host:'localhost',port:3000,path:'/api/health'}, res=>process.exit(res.statusCode===200?0:1)); req.on('error', ()=>process.exit(1)); req.end();"

# Start the backend
CMD ["node", "server.js"]