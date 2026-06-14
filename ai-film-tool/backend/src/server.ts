import app from './app';
import { config } from './config/env';

const startServer = () => {
  const port = config.port;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
};

startServer();
