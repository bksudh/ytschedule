FROM nginx:alpine

# Clean default content
RUN rm -rf /usr/share/nginx/html/*

# Copy static frontend assets
COPY frontend/ /usr/share/nginx/html/

# Use project-provided nginx config
COPY nginx/nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

# No CMD override; use Nginx default