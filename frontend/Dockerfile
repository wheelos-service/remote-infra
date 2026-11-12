FROM node:22-alpine AS build
WORKDIR /repo
COPY packages/teleop-shared/package*.json packages/teleop-shared/
RUN npm ci --prefix packages/teleop-shared --no-audit
COPY frontend/package*.json frontend/
RUN npm ci --prefix frontend --no-audit
COPY packages/teleop-shared/ packages/teleop-shared/
COPY frontend/ frontend/
RUN npm --prefix frontend run build

FROM nginx:stable-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/frontend/dist/ /usr/share/nginx/html/
EXPOSE 80
