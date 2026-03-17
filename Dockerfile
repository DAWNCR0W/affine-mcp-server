# Use a minimal Node.js image
FROM node:alpine

# Set working directory
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY --parents=true ./dist/* ./

# Expose the app port (adjust if needed)
EXPOSE 3000


# Start the application
CMD ["sh", "-c", "MCP_TRASPORT=http node dist/index.js"]