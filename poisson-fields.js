'use strict';

var botUtilities = require('bot-utilities');
var fs = require('fs');
var nouns = require('./nouns.json').nouns;
var program = require('commander');
var request = require('request');
var Twit = require('twit');
var _ = require('lodash');

var Canvas = require('canvas-utilities').Canvas;
var canvasUtilities = require('canvas-utilities/lib/utilities.js');
var ImageHelper = require('canvas-utilities/lib/image-helper.js');
var PoissonImageGrid = require('canvas-utilities/lib/poisson-image-grid.js');
var SequentialImageSet = require('canvas-utilities/lib/sequential-image-set.js');

_.mixin(botUtilities.lodashMixins);
_.mixin(Twit.prototype, botUtilities.twitMixins);

var Bing = require('node-bing-api')({
  accKey: process.env.BING_KEY
});

var FULLY_TRANSPARENT = 0;

function getPixel(data, index) {
  var i = index * 4;

  // returns array [R, G, B, A]
  return [
    data.data[i],
    data.data[i + 1],
    data.data[i + 2],
    data.data[i + 3]
  ];
}

function getPixelXY(data, x, y) {
  return getPixel(data, y * data.width + x);
}

function getPixelA(data, x, y) {
  return getPixelXY(data, x, y)[3];
}

function isSuitable(path) {
  return new Promise(function (resolve, reject) {
    fs.readFile(path, function (err, imageData) {
      if (err) {
        return reject(err);
      }

      var image = new Canvas.Image();

      image.onerror = function (imageError) {
        console.log('image error', path, imageError);

        resolve(false);
      };

      image.onload = function () {
        var canvas = new Canvas(image.width, image.height);
        var ctx = canvas.getContext('2d');

        ctx.drawImage(image, 0, 0, image.width, image.height);

        var data = ctx.getImageData(0, 0, canvas.width, canvas.height);

        var areCornersTransparent =
          getPixelA(data, 0, 0) === FULLY_TRANSPARENT &&
          getPixelA(data, 0, image.height - 1) === FULLY_TRANSPARENT &&
          getPixelA(data, image.width - 1, 0) === FULLY_TRANSPARENT &&
          getPixelA(data, image.width - 1, image.height - 1) === FULLY_TRANSPARENT;

        resolve(areCornersTransparent);
      };

      image.src = imageData;
    });
  });
}

function search(term) {
  return new Promise(function (resolve, reject) {
    Bing.images(term, {}, function (err, res, body) {
      if (err) {
        return reject(err);
      }

      var candidates = body.d.results.filter(function (result) {
        return result.ContentType !== 'image/jpeg' &&
               result.ContentType !== 'image/jpg';
      });

      var urls = _.pluck(candidates, 'MediaUrl');

      resolve(urls);
    });
  });
}

var count = 0;

function download(url) {
  return new Promise(function (resolve, reject) {
    var path = `./out/${++count}.png`;

    request
      .get(url)
      .on('error', function (err) {
        reject(err);
      })
      .on('end', function () {
        resolve(path);
      })
      .pipe(fs.createWriteStream(path));
  });
}

async function makeImage(cb) {
  try {
    var word = _.sample(nouns);
    var candidates = [];

    console.log(`using ${word}`);

    var urls = _.sample(await search(`transparent ${word}`), 10);

    for (let url of urls) {
      var path = await download(url);

      console.log('downloaded', path);

      var suitable = await isSuitable(path);

      if (suitable) {
        candidates.push(path);
      }
    }

    var WIDTH = 900;
    var HEIGHT = 450;

    var canvas = new Canvas(WIDTH, HEIGHT);
    var ctx = canvasUtilities.getContext(canvas);

    var background = ImageHelper.fromFile('./backgrounds/space-1.jpg')
      .context(ctx);

    background.draw(0, 0, background.width / 5, background.height / 5);

    var rotationAngle = _.random(-60, 60);

    var images = _.sample(candidates, _.random(1, 3));
    var imageSet = new SequentialImageSet(images)
      .context(ctx);

    console.log(images);

    _.times(images.length, function () {
      var image = imageSet.image();

      var maxSize = _.random(90, 150);
      var size = Math.max(image.width, image.height);

      image.scale(maxSize / size);
      image.rotate(rotationAngle);

      imageSet.increment();
    });

    new PoissonImageGrid()
      .images(imageSet)
      .width(WIDTH)
      .height(HEIGHT)
      .draw();

    canvas.toBuffer(function (err, buffer) {
      if (err) {
        throw err;
      }

      cb(word, buffer);
    });
  } catch (e) {
    cb(e);
  }
}

program
  .command('tweet')
  .description('Generate and tweet an image')
  .option('-r, --random', 'only post a percentage of the time')
  .action(async function (options) {
    if (options.random) {
      if (_.percentChance(98)) {
        console.log('Skipping...');

        process.exit(0);
      }
    }

    makeImage(function (word, buffer) {
      var T = new Twit(botUtilities.getTwitterAuthFromEnv());

      var tweet = word + ' ';

      if (_.percentChance(25)) {
        var bot = botUtilities.imageBot();

        tweet += botUtilities.heyYou(bot);

        if (bot === 'Lowpolybot') {
          tweet += ' #noRT';
        }
      }

      tweet = {status: tweet};

      T.updateWithMedia(tweet, buffer, function (err, response) {
        if (err) {
          return console.error('TUWM error', err, response.statusCode);
        }

        console.log('TUWM OK');
      });
    });
  });

program.parse(process.argv);
