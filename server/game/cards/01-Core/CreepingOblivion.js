const Card = require('../../Card.js');

class CreepingOblivion extends Card {
    setupCardAbilities(ability) {
        this.play({
            targets: {
                select: {
                    mode: 'select',
                    activePromptTitle: 'Choose which discard pile to purge from',
                    choices: {
                        'Mine': context => context.player.discard.length > 0,
                        'Opponent\'s': context => context.player.opponent && context.player.opponent.discard.length > 0
                    }
                },
                cards: {
                    dependsOn: 'select',
                    mode: 'upTo',
                    numCards: 2,
                    player: context => context.selects.select.choice === 'Mine' ? context.player : context.player.opponent,
                    location: 'discard',
                    gameAction: ability.actions.purge()
                }
            }
        });
    }
}

CreepingOblivion.id = 'creeping-oblivion'; // This is a guess at what the id might be - please check it!!!

module.exports = CreepingOblivion;