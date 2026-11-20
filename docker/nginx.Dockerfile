FROM nginx:stable-alpine

COPY nginx/compose.conf /etc/nginx/nginx.conf
