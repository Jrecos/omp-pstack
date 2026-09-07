# Benny workspace fixture image: Bun + Chromium + ffmpeg.
# The trusted control adapter is baked in at /opt/benny-control (root-owned,
# outside the /workspace mount the run worktree is mounted at), so the
# coordinator can never edit the code that enforces its own boundary.
FROM oven/bun:1.3-debian

RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium ffmpeg procps \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/benny-control /workspace /artifacts /tmp/benny-control \
	&& chown -R 1000:1000 /workspace /artifacts /tmp/benny-control

COPY control.mjs /opt/benny-control/control.mjs
RUN chown root:root /opt/benny-control/control.mjs && chmod 0555 /opt/benny-control/control.mjs && chmod 0777 /tmp/benny-control

USER 1000:1000
ENV HOME=/tmp/benny-control/home
WORKDIR /workspace
CMD ["sleep", "infinity"]
