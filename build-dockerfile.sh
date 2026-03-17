#!/bin/sh

npm install
npm run build

docker build -t mordockdun/affine-mcp-server-dockerized:v1 .

## To push the image to Docker Hub, make sure you're logged in and then run:
# docker push mordockdun/affine-mcp-server-dockerized:v1