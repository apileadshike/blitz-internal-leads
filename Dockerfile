FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx next build
ENV NODE_ENV=production JOBS_DIR=/data/jobs
# Let the app handle SIGTERM itself so running jobs save their place before exiting.
ENV NEXT_MANUAL_SIG_HANDLE=true
# Leads and job state live in Supabase. /data only holds the job files: mount a small volume there.
VOLUME ["/data"]
EXPOSE 4000
STOPSIGNAL SIGTERM
CMD ["npx", "next", "start", "-p", "4000"]
