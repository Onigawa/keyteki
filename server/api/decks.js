const passport = require('passport');
const fs = require('fs');
const rimraf = require('rimraf');
const exif = require('exif-parser');
const asyncHandler = require('express-async-handler');
const ConfigService = require('../services/ConfigService');
const DeckService = require('../services/DeckService.js');
const { isValidImage, processImage } = require('../util.js');
const logger = require('../log.js');
const ServiceFactory = require('../services/ServiceFactory');
const configService = new ConfigService();
const cardService = ServiceFactory.cardService(configService);

const deckService = new DeckService(configService);

const writeImage = (filename, image) => {
    return new Promise((resolve, reject) => {
        fs.writeFile(filename, image, 'base64', (err) => {
            if (err) {
                reject(err);
            }

            resolve();
        });
    });
};

module.exports.init = function (server) {
    server.get(
        '/api/standalone-decks',
        asyncHandler(async (req, res) => {
            let decks;

            try {
                decks = await deckService.getStandaloneDecks();
            } catch (err) {
                logger.error('Failed to get standalone decks', err);

                throw new Error('Failed to get standalone decks');
            }

            res.send({ success: true, decks: decks });
        })
    );

    server.get(
        '/api/decks/flagged',
        passport.authenticate('jwt', { session: false }),
        asyncHandler(async (req, res) => {
            if (!req.user.permissions || !req.user.permissions.canVerifyDecks) {
                return res.status(403);
            }

            let decks = await deckService.getFlaggedUnverifiedDecks();

            res.send({ success: true, decks: decks });
        })
    );

    server.get(
        '/api/decks/:id',
        passport.authenticate('jwt', { session: false }),
        asyncHandler(async (req, res) => {
            if (!req.params.id || req.params.id === '') {
                return res.status(404).send({ message: 'No such deck' });
            }

            let deck = await deckService.getById(req.params.id);

            if (!deck) {
                return res.status(404).send({ message: 'No such deck' });
            }

            if (deck.username !== req.user.username) {
                return res.status(401).send({ message: 'Unauthorized' });
            }

            res.send({ success: true, deck: deck });
        })
    );

    server.get(
        '/api/decks',
        passport.authenticate('jwt', { session: false }),
        asyncHandler(async (req, res) => {
            let numDecks = await deckService.getNumDecksForUser(req.user, req.query);
            let decks = [];

            if (numDecks > 0) {
                decks = (await deckService.findForUser(req.user, req.query)).map((deck) => {
                    let deckUsageLevel = 0;
                    if (
                        deck.usageCount >
                        configService.getValueForSection('lobby', 'lowerDeckThreshold')
                    ) {
                        deckUsageLevel = 1;
                    }

                    if (
                        deck.usageCount >
                        configService.getValueForSection('lobby', 'middleDeckThreshold')
                    ) {
                        deckUsageLevel = 2;
                    }

                    if (
                        deck.usageCount >
                        configService.getValueForSection('lobby', 'upperDeckThreshold')
                    ) {
                        deckUsageLevel = 3;
                    }

                    deck.usageLevel = deckUsageLevel;
                    deck.usageCount = undefined;

                    let hasEnhancementsSet = true;
                    let hasEnhancements = false;
                    if (deck.cards.some((c) => c.enhancements && c.enhancements[0] === '')) {
                        hasEnhancementsSet = false;
                    }

                    if (deck.cards.some((c) => c.enhancements)) {
                        hasEnhancements = true;
                    }

                    deck.basicRules = hasEnhancementsSet;
                    deck.notVerified = hasEnhancements && !deck.verified;

                    return deck;
                });
            }

            res.send({ success: true, numDecks: numDecks, decks: decks });
        })
    );

    server.post(
        '/api/decks',
        passport.authenticate('jwt', { session: false }),
        asyncHandler(async (req, res) => {
            if (!req.body.uuid) {
                return res.send({ success: false, message: 'uuid must be specified' });
            }

            let deck = Object.assign({}, { uuid: req.body.uuid, username: req.user.username });
            let savedDeck;

            try {
                savedDeck = await deckService.create(req.user, deck);
            } catch (error) {
                return res.send({
                    success: false,
                    message: error.message
                });
            }

            if (!savedDeck) {
                return res.send({
                    success: false,
                    message:
                        'An error occurred importing your deck.  Please check the Url or try again later.'
                });
            }

            res.send({ success: true, deck: savedDeck });
        })
    );

    server.delete(
        '/api/decks/:id',
        passport.authenticate('jwt', { session: false }),
        asyncHandler(async (req, res) => {
            let id = req.params.id;

            let deck = await deckService.getById(id);

            if (!deck) {
                return res.status(404).send({ success: false, message: 'No such deck' });
            }

            if (deck.username !== req.user.username) {
                return res.status(401).send({ message: 'Unauthorized' });
            }

            await deckService.delete(id);
            res.send({ success: true, message: 'Deck deleted successfully', deckId: id });
        })
    );

    server.post(
        '/api/decks/:id/verify',
        passport.authenticate('jwt', { session: false }),
        asyncHandler(async (req, res) => {
            if (!req.user.permissions || !req.user.permissions.canVerifyDecks) {
                return res.status(403);
            }

            let id = req.params.id;

            let deck = await deckService.getById(id);

            if (!deck) {
                return res.status(404).send({ success: false, message: 'No such deck' });
            }

            deck.verified = true;
            deck.id = id;

            await deckService.update(deck);

            if (fs.existsSync(`public/img/deck-verification/${deck.id}/`)) {
                rimraf.sync(`public/img/deck-verification/${deck.id}`);
            }

            res.send({ success: true, message: 'Deck verified successfully', deckId: id });
        })
    );

    server.post(
        '/api/decks/:id/enhancements',
        passport.authenticate('jwt', { session: false }),
        asyncHandler(async (req, res) => {
            let id = req.params.id;

            let deck = await deckService.getById(id);
            if (!deck) {
                return res.status(404).send({ success: false, message: 'No such deck' });
            }

            if (deck.username !== req.user.username) {
                return res.status(401).send({ message: 'Unauthorized' });
            }

            const enhancementRegex = /Enhance (.+?)\./;
            let totalEnhancements = 0;
            let totalUsed = 0;
            const EnhancementLookup = {
                P: 'capture',
                D: 'damage',
                R: 'draw',
                A: 'amber'
            };

            let cards = await cardService.getAllCards();

            let cardsWithEnhancements = deck.cards.filter((c) => c.enhancements).length;
            let enhancedCards = Object.values(req.body.enhancements).length;
            for (let deckCard of deck.cards.filter(
                (c) => cards[c.id].text && cards[c.id].text.includes('Enhance')
            )) {
                let matches = cards[deckCard.id].text.match(enhancementRegex);
                if (!matches || matches.length === 1) {
                    continue;
                }

                let enhancementString = matches[1];
                for (let char of enhancementString) {
                    let enhancement = EnhancementLookup[char];
                    if (enhancement) {
                        for (let i = 0; i < deckCard.count; i++) {
                            totalEnhancements++;
                        }
                    }
                }
            }

            for (const [id, enhancements] of Object.entries(req.body.enhancements)) {
                let card = deck.cards.find((c) => c.dbId == id);
                let newEnhancements = [];

                for (let [enhancement, count] of Object.entries(enhancements)) {
                    for (let i = 0; i < count; i++) {
                        newEnhancements.push(enhancement);
                        totalUsed++;
                    }
                }

                card.enhancements = newEnhancements;
            }

            if (totalUsed < totalEnhancements || enhancedCards < cardsWithEnhancements) {
                return res.send({ success: false, message: 'Enhancements incorrectly assigned' });
            }

            await deckService.update(deck);
            res.send({ success: true, message: 'Enhancements added successfully', deckId: id });
        })
    );

    server.post(
        '/api/decks/:id/uploadVerification',
        passport.authenticate('jwt', { session: false }),
        asyncHandler(async (req, res) => {
            let id = req.params.id;

            let deck = await deckService.getById(id);
            if (!deck) {
                return res.status(404).send({ success: false, message: 'No such deck' });
            }

            if (deck.username !== req.user.username) {
                return res.status(401).send({ message: 'Unauthorized' });
            }

            for (let image of Object.values(req.body.images)) {
                if (!isValidImage(image)) {
                    return res.status(400).send({ success: false, message: 'Invalid card image' });
                }
            }

            if (!fs.existsSync('public/img/deck-verification/')) {
                fs.mkdirSync('public/img/deck-verification/');
            }

            if (!fs.existsSync(`public/img/deck-verification/${deck.id}/`)) {
                fs.mkdirSync(`public/img/deck-verification/${deck.id}/`);
            }

            let cardsNeedingVerification = {};

            for (let card of deck.cards.filter((card) => card.enhancements)) {
                cardsNeedingVerification[card.dbId] = card;
            }

            for (let [cardId, image] of Object.entries(req.body.images)) {
                if (cardId != 'id-card' && !cardsNeedingVerification[cardId]) {
                    return res
                        .status(400)
                        .send({ success: false, message: 'Card not needing verification' });
                }

                console.info('processing card', cardId);

                let fileData;
                let rotate = false;
                try {
                    let buffer = Buffer.from(image, 'base64');
                    let parser = exif.create(buffer);
                    let result = parser.parse();

                    if (result && result.tags && result.tags.Orientation === 6) {
                        rotate = true;
                    }
                } catch (err) {
                    logger.error(err);
                }

                console.info('exif checked', cardId);

                try {
                    fileData = await processImage(image, 300, 420, rotate);

                    console.info('process done, writing', cardId);

                    await writeImage(
                        `public/img/deck-verification/${deck.id}/${cardId}.png`,
                        fileData
                    );

                    console.info('writing done', cardId);
                } catch (err) {
                    logger.error(err);
                    return res.send({
                        success: false,
                        message: 'An error occured uploading your deck images.'
                    });
                }
            }

            await deckService.flagDeckForVerification(deck);

            res.send({ success: true, message: 'Images uploaded successfully.' });
        })
    );
};
