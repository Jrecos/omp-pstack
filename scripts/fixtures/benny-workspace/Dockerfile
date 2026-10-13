# Benny workspace fixture image: Bun + Chromium + ffmpeg.
# The trusted control adapter is baked in at /opt/benny-control (root-owned,
# outside the /workspace mount the run worktree is mounted at), so the
# coordinator can never edit the code that enforces its own boundary.
FROM oven/bun:1.3-debian
ARG BENNY_UID=1000
ARG BENNY_GID=1000

RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium ffmpeg procps \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/benny-control /workspace /artifacts /tmp/benny-control \
	&& chown -R ${BENNY_UID}:${BENNY_GID} /workspace /artifacts /tmp/benny-control

COPY control.mjs /opt/benny-control/control.mjs
RUN chown root:root /opt/benny-control/control.mjs && chmod 0555 /opt/benny-control/control.mjs && chmod 0777 /tmp/benny-control

USER ${BENNY_UID}:${BENNY_GID}
ENV HOME=/tmp/benny-control/home
WORKDIR /workspace
CMD ["sleep", "infinity"]
