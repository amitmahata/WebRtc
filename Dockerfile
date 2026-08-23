FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app source code
COPY . .

# Expose server port (default 3000)
EXPOSE 3000

# Start application
CMD ["npm", "start"]
