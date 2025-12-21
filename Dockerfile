ARG BUN_VERSION=1
FROM oven/bun:${BUN_VERSION} AS build

WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the rest of the source code
COPY . .

ARG VITE_SPOTIFY_CLIENT_ID
ENV VITE_SPOTIFY_CLIENT_ID=$VITE_SPOTIFY_CLIENT_ID

# Build the Vue application (outputs to /app/dist)
RUN bun run build

# Compile the server into a standalone executable
RUN bun build --compile --minify --sourcemap server.ts --outfile server

##########################################################
FROM busybox:uclibc AS busybox

##########################################################
FROM gcr.io/distroless/base-debian12

WORKDIR /app

# Copy shell and wget for debugging/healthchecks (optional but useful)
COPY --from=busybox /bin/sh /bin/sh
COPY --from=busybox /bin/wget /usr/bin/wget

# Copy the built frontend assets from the build stage
COPY --from=build /app/dist ./dist

# Copy the compiled server executable
COPY --from=build /app/server .

# Expose the port the server listens on
EXPOSE 3001

# Start the server
CMD ["./server"]
