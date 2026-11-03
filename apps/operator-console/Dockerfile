FROM node:22 AS build
WORKDIR /repo
COPY packages/teleop-shared/package*.json packages/teleop-shared/
RUN npm ci --prefix packages/teleop-shared --no-audit
COPY apps/operator-console/package*.json apps/operator-console/
RUN npm ci --prefix apps/operator-console --no-audit
COPY packages/teleop-shared/ packages/teleop-shared/
COPY apps/operator-console/ apps/operator-console/
RUN npm --prefix apps/operator-console run build

FROM nginx:stable-alpine
COPY --from=build /repo/apps/operator-console/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
