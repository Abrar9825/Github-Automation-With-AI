import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI('AIzaSyC1oYV_etbKznRaIJxY1MePFd6Nq9BEEw0');
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const prompt = 'who is make python programming';

const result = await model.generateContent(prompt);
console.log(result.response.text());
