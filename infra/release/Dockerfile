FROM docker:28-cli
RUN apk add --no-cache python3 ca-certificates
WORKDIR /opt/teleop
COPY deploy.py release-images.json /opt/teleop/infra/scripts/
ENV HOME=/tmp
ENTRYPOINT ["python3", "/opt/teleop/infra/scripts/deploy.py"]
