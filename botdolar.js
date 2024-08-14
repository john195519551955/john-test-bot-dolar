const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const natural = require('natural');
const schedule = require('node-schedule');

const rssParser = new Parser();
const analyzer = new natural.SentimentAnalyzer('Portuguese', natural.PorterStemmerPt, 'afinn');

const ALPHA_VANTAGE_API_KEY = '9MGZRC45N8EW1ZQ7'; // Sua API Key do Alpha Vantage

// Variáveis globais para armazenar estado
let processedNewsTitles = new Set();  // Para armazenar títulos de notícias já processados
let sentimentScores = [];  // Para armazenar os últimos sentimentos calculados
let lastPrice = 0; // Para armazenar o último preço processado

// Função para coletar previsões de mercado de sites existentes
async function getMarketForecast() {
    try {
        const { data } = await axios.get('https://www.investing.com/currencies/usd-brl');
        const $ = cheerio.load(data);
        const forecast = $('div.forex-ticker').text().trim();
        return forecast;
    } catch (error) {
        console.error('Erro ao coletar previsão de mercado:', error);
    }
}

// Função para coletar notícias relevantes (via RSS feed)
async function getNews() {
    try {
        const feed = await rssParser.parseURL('https://news.google.com/rss/search?q=dólar+economia+brasil&hl=pt-BR&gl=BR&ceid=BR:pt-419');
        return feed.items.map(item => ({
            title: item.title,
            content: item.contentSnippet // Resumo da notícia para análise de sentimento
        }));
    } catch (error) {
        console.error('Erro ao coletar notícias:', error);
        return []; // Retorna um array vazio se houver erro
    }
}

// Função para realizar análise de sentimento nas notícias
function analyzeSentiment(news) {
    const sentimentScore = analyzer.getSentiment(news.content.split(' '));
    return sentimentScore;
}

// Função para coletar dados históricos do dólar (usando Alpha Vantage)
async function getHistoricalData() {
    try {
        const { data } = await axios.get(`https://www.alphavantage.co/query`, {
            params: {
                function: 'FX_DAILY',
                from_symbol: 'USD',
                to_symbol: 'BRL',
                outputsize: 'compact',  // Usar "compact" para obter apenas os últimos 100 registros mais recentes
                apikey: ALPHA_VANTAGE_API_KEY
            }
        });
        const timeSeries = data['Time Series FX (Daily)'];
        const sortedDates = Object.keys(timeSeries).sort((a, b) => new Date(b) - new Date(a)); // Ordena as datas do mais recente para o mais antigo
        const recentData = sortedDates.slice(0, 60).reduce((obj, key) => {
            obj[key] = timeSeries[key];
            return obj;
        }, {});
        return recentData;
    } catch (error) {
        console.error('Erro ao coletar dados históricos do Alpha Vantage:', error);
    }
}

// Função para calcular a média móvel simples (SMA)
function calculateSMA(prices, period) {
    let sma = [];
    for (let i = 0; i <= prices.length - period; i++) {
        const slice = prices.slice(i, i + period);
        const sum = slice.reduce((acc, val) => acc + parseFloat(val), 0);
        sma.push(sum / period);
    }
    return sma;
}

// Função para calcular a média móvel exponencial (EMA)
function calculateEMA(prices, period) {
    let ema = [];
    let multiplier = 2 / (period + 1);
    let previousEma = prices.slice(0, period).reduce((acc, val) => acc + parseFloat(val), 0) / period;
    ema.push(previousEma);
    
    for (let i = period; i < prices.length; i++) {
        const currentEma = (parseFloat(prices[i]) - previousEma) * multiplier + previousEma;
        ema.push(currentEma);
        previousEma = currentEma;
    }
    return ema;
}

// Função para calcular as Bollinger Bands
function calculateBollingerBands(prices, period = 20) {
    const sma = calculateSMA(prices, period);
    const stddev = prices.slice(period - 1).map((price, idx) => {
        const mean = sma[idx];
        const squaredDiffs = prices.slice(idx, idx + period).map(p => Math.pow(p - mean, 2));
        return Math.sqrt(squaredDiffs.reduce((acc, val) => acc + val) / period);
    });
    const upperBand = sma.map((mean, idx) => mean + (stddev[idx] * 2));
    const lowerBand = sma.map((mean, idx) => mean - (stddev[idx] * 2));
    return { upperBand, lowerBand };
}

// Função para calcular o RSI
function calculateRSI(prices, period = 14) {
    let gains = [];
    let losses = [];
    for (let i = 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) {
            gains.push(change);
            losses.push(0);
        } else {
            gains.push(0);
            losses.push(Math.abs(change));
        }
    }
    const averageGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const averageLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

    const rs = averageGain / averageLoss;
    const rsi = 100 - (100 / (1 + rs));
    return rsi;
}

// Função para identificar suportes e resistências
function identifySupportResistance(prices) {
    const recentPrices = prices.slice(-60); // Analisando os últimos 60 dias para suporte e resistência
    let support = Math.min(...recentPrices);
    let resistance = Math.max(...recentPrices);
    return { support, resistance };
}

// Função para calcular a previsão do dólar nas próximas 24 horas
async function updatePrediction() {
    const news = await getNews();
    const newNews = news.filter(item => !processedNewsTitles.has(item.title));

    if (newNews.length > 0 || await hasSignificantPriceChange()) {
        console.clear();  // Limpa o terminal para uma saída mais limpa
        console.log("=== Nova Previsão ===");

        newNews.forEach(item => {
            processedNewsTitles.add(item.title);

            // Analisar o sentimento da nova notícia
            const sentiment = analyzeSentiment(item);
            sentimentScores.push(sentiment);

            // Manter apenas os últimos 10 sentimentos para a previsão
            if (sentimentScores.length > 10) {
                sentimentScores.shift();
            }
        });

        // Calcular a previsão baseada na média dos últimos sentimentos
        const averageSentiment = sentimentScores.reduce((a, b) => a + b, 0) / sentimentScores.length;

        // Obter dados históricos e calcular indicadores técnicos
        const historicalData = await getHistoricalData();
        if (!historicalData) {
            console.error('Erro: Dados históricos não disponíveis.');
            return;
        }

        const closingPrices = Object.values(historicalData).map(day => parseFloat(day['4. close']));
        
        const sma = calculateSMA(closingPrices, 20);  // Usando um período maior para SMA e EMA
        const ema = calculateEMA(closingPrices, 20);
        const bollingerBands = calculateBollingerBands(closingPrices);
        const rsi = calculateRSI(closingPrices);
        const { support, resistance } = identifySupportResistance(closingPrices);

        lastPrice = closingPrices[0]; // Atualiza o último preço processado

        let possiblePrice = lastPrice;

        if (averageSentiment > 0 && lastPrice > sma[0] && lastPrice > ema[0] && lastPrice > support && rsi < 70) {
            possiblePrice += averageSentiment * 0.01;  // Ajustado para maior realismo
            console.log("Recomendação: Possível alta do dólar nas próximas 24 horas.");
        } else if (averageSentiment < 0 && lastPrice < sma[0] && lastPrice < ema[0] && lastPrice < resistance && rsi > 30) {
            possiblePrice -= Math.abs(averageSentiment) * 0.01;  // Ajustado para maior realismo
            console.log("Recomendação: Possível queda do dólar nas próximas 24 horas.");
        } else if (lastPrice > bollingerBands.upperBand[0]) {
            console.log("Recomendação: Possível correção para baixo (dólar sobrecomprado).");
            possiblePrice -= 0.01;
        } else if (lastPrice < bollingerBands.lowerBand[0]) {
            console.log("Recomendação: Possível correção para cima (dólar sobrevendido).");
            possiblePrice += 0.01;
        } else {
            console.log("Recomendação: Possível estabilidade do dólar nas próximas 24 horas.");
        }

        // Mostrar os resultados da previsão
        console.log(`Preço estimado do dólar para as próximas 24 horas: R$ ${possiblePrice.toFixed(2)}`);
        console.log(`Suporte: R$ ${support.toFixed(2)}, Resistência: R$ ${resistance.toFixed(2)}`);
        console.log(`RSI: ${rsi.toFixed(2)}, Bollinger Bands (U: ${bollingerBands.upperBand[0].toFixed(2)}, L: ${bollingerBands.lowerBand[0].toFixed(2)})`);
    } else {
        console.clear();
        console.log("=== Aguardando nova previsão... ===");
    }
}

// Função para verificar se houve uma mudança significativa no preço
async function hasSignificantPriceChange() {
    // Define o percentual de mudança significativa
    const threshold = 0.5; // 0.5% de mudança é considerado significativo
    const historicalData = await getHistoricalData();
    const closingPrices = Object.values(historicalData).map(day => parseFloat(day['4. close']));
    
    // Verifica a mudança percentual entre o último preço registrado e o novo preço
    const lastRecordedPrice = lastPrice || closingPrices[1]; // Use o último preço conhecido ou o segundo mais recente
    const currentPrice = closingPrices[0];
    const percentChange = Math.abs((currentPrice - lastRecordedPrice) / lastRecordedPrice) * 100;

    return percentChange >= threshold;
}

// Agendar verificação periódica
schedule.scheduleJob('*/30 * * * *', updatePrediction);  // Verifica a cada 30 minutos, mas só atualiza se necessário

// Executa imediatamente ao iniciar
updatePrediction();
