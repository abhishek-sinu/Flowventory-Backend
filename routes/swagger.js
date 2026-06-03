import express from 'express';
const router = express.Router();
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'ISKCON Donation Management System API',
      version: '1.0.0',
    },
  },
  apis: ['./routes/*.js'], // Path to the API docs
};

const specs = swaggerJsdoc(options);

router.use('/', swaggerUi.serve);
router.get('/', swaggerUi.setup(specs));

export default router;
