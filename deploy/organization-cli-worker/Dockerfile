# Local artifact recipe, not a deployed multi-user service.
FROM public.ecr.aws/aws-cli/aws-cli:2.30.1 AS awscli
FROM node:24.19.0-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server ./server
COPY src/domain ./src/domain
COPY src/modules/aws/domain ./src/modules/aws/domain
COPY scripts/build-cli-worker.mjs ./scripts/build-cli-worker.mjs
COPY scripts/company-build-policy.mjs ./scripts/company-build-policy.mjs
COPY tsconfig.json ./tsconfig.json
RUN node scripts/build-cli-worker.mjs

FROM node:24.19.0-bookworm-slim
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin cloudops-worker \
    && chmod 700 /home/cloudops-worker \
    && mkdir -p /home/cloudops-worker/.aws /run/cloudops /app \
    && chown cloudops-worker:cloudops-worker /home/cloudops-worker/.aws \
    && chmod 700 /home/cloudops-worker/.aws
COPY --from=awscli /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws
COPY --from=build /build/dist-worker/worker.mjs /app/worker.mjs
USER 10001:10001
WORKDIR /app
ENV CLOUDOPS_CLI_WORKER=1
ENTRYPOINT ["node", "/app/worker.mjs"]
