# Use the official Node.js 18 alpine image for a small footprint
FROM node:18-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install dependencies (only production dependencies for smaller image)
RUN npm ci --only=production

# Install pm2 globally to run the app in cluster mode
RUN npm install -g pm2

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Start the application with pm2 in cluster mode (max instances = max CPU cores)
CMD ["pm2-runtime", "start", "index.js", "-i", "max"]
