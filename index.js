const youtubedl = require('youtube-dl');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const request = require('request-promise');
const requestNoPromise = require('request');
const _ = require('lodash');
const acoustid = require('acoustid');
const EyeD3 = require('eyed3');
const eyed3 = new EyeD3({ eyed3_executable: 'eyeD3' });
const levenshtein = require('fast-levenshtein');
const crypto = require('crypto');
const cheerio = require('cheerio');
const Promise = require('bluebird');

// API keys
const API_ECHONEST_KEY = 'BPDC3NESDOHXKDIBZ';
const API_ACOUSTID = 'lm59lNN597';
const API_GOOGLE = 'AIzaSyBCshUQSpLKuhmfE5Jc-LEm6vH-sab5Vl8';
const API_SOUNDCLOUD = 'dba290d84e6ca924414c91ac12fc3c8f';

var at3 = {};

/**
* Find lyrics for a song
* @param title string
* @param artistName string
* @return Promise
*/
at3.findLyrics = function(title, artistName) {
    var promises = [];

    function textln(html) {
        html.find('br').replaceWith('\n');
        html.find('script').replaceWith('');
        html.find('#video-musictory').replaceWith('');
        html.find('strong').replaceWith('');
        html = _.trim(html.text());
        html = html.replace(/\r\n\n/g, '\n');
        html = html.replace(/\t/g, '');
        html = html.replace(/\n\r\n/g, '\n');
        html = html.replace(/ +/g, ' ');
        html = html.replace(/\n /g, '\n');
        return html;
    }

    function lyricsUrl(title) {
    	return _.kebabCase(_.trim(_.toLower(_.deburr(title))));
    }
    function lyricsManiaUrl(title) {
    	return _.snakeCase(_.trim(_.toLower(_.deburr(title))));
    }

    var reqWikia = request({
        uri: 'http://lyrics.wikia.com/wiki/' + encodeURIComponent(artistName) + ':' + encodeURIComponent(title),
        transform: function (body) {
            return cheerio.load(body);
        }
    }).then(function($) {
        return textln($('.lyricbox'));
    });

    var reqParolesNet = request({
        uri: 'http://www.paroles.net/' + lyricsUrl(artistName) + '/paroles-' + lyricsUrl(title),
        transform: function (body) {
            return cheerio.load(body);
        }
    }).then(function($) {
        if ($('.song-text').length === 0) {
            return Promise.reject();
        }
        return textln($('.song-text'));
    });

    var reqLyricsMania1 = request({
        uri: 'http://www.lyricsmania.com/' + lyricsManiaUrl(title) + '_lyrics_' + lyricsManiaUrl(artistName) + '.html',
        transform: function (body) {
            return cheerio.load(body);
        }
    }).then(function($) {
        if ($('.lyrics-body').length === 0) {
            return Promise.reject();
        }
        return textln($('.lyrics-body'));
    });

    var reqLyricsMania2 = request({
        uri: 'http://www.lyricsmania.com/' + lyricsManiaUrl(title) + '_' + lyricsManiaUrl(artistName) + '.html',
        transform: function (body) {
            return cheerio.load(body);
        }
    }).then(function($) {
        console.log('alors');
        if ($('.lyrics-body').length === 0) {
            return Promise.reject();
        }
        console.log('oh');
        return textln($('.lyrics-body'));
    });

    var reqSweetLyrics = request({
        method: 'POST',
        uri: 'http://www.sweetslyrics.com/search.php',
        form: {
            search: 'title',
            searchtext: title
        },
        transform: function (body) {
            return cheerio.load(body);
        }
    }).then(function($) {
        var closestLink, closestScore = -1;
        _.forEach($('.search_results_row_color'), function (e) {
            var artist = $(e).text().replace(/ - .+$/, '');
            var currentScore = levenshtein.get(artistName, artist);
            if (closestScore == -1 || currentScore < closestScore) {
                closestScore = currentScore;
                closestLink = $(e).find('a').last().attr('href');
            }
        });
        if (!closestLink) {
            return Promise.reject();
        }
        return request({
            uri: 'http://www.sweetslyrics.com/' + closestLink,
            transform: function (body) {
                return cheerio.load(body);
            }
        });
    }).then(function($) {
        return textln($('.lyric_full_text'));
    });

    if (/\(.*\)/.test(title) || /\[.*\]/.test(title)) {
        promises.push(at3.findLyrics(title.replace(/\(.*\)/g, '').replace(/\[.*\]/g, ''), artistName));
    }

    promises.push(reqWikia);
    promises.push(reqParolesNet);
    promises.push(reqLyricsMania1);
    promises.push(reqLyricsMania2);
    promises.push(reqSweetLyrics);

    return Promise.any(promises).then(function(lyrics) {
        return lyrics;
    });
};

/**
* Returns true if the query corresponds
* to an URL, else false
* @param query string
* @return boolean
*/
at3.isURL = function(query) {
    return /^http(s?):\/\//.test(query);
};

/**
* Download a single video with youtube-dl
* @param url
* @param outputFile
* @return Event
*/
at3.downloadWithYoutubeDl = function(url, outputFile) {
    var download = youtubedl(url, ['-f', 'bestaudio']);
    const downloadEmitter = new EventEmitter();

    var size = 0;
    download.on('info', function(info) {
        size = info.size;

        downloadEmitter.emit('download-start', {
            size: size
        });

        download.pipe(fs.createWriteStream(outputFile));
    });

    var pos = 0;
    download.on('data', function data(chunk) {
        pos += chunk.length;

        if (size) {
            var percent = (pos / size * 100).toFixed(2);

            downloadEmitter.emit('download-progress', {
                downloaded: pos,
                progress: percent
            });
        }
    });

    download.on('end', function end() {
        downloadEmitter.emit('download-end');
    });

    return downloadEmitter;
};

/**
* Convert a outputFile in MP3
* @param inputFile
* @param outputFile
* @param bitrate string
* @return Event
*/
at3.convertInMP3 = function(inputFile, outputFile, bitrate) {
    const convertEmitter = new EventEmitter();

    var convert = ffmpeg(inputFile)
    .audioBitrate(bitrate)
    .audioCodec('libmp3lame')
    .on('codecData', function(data) {
        convertEmitter.emit('convert-start');
    })
    .on('progress', function(progress) {
        convertEmitter.emit('convert-progress', {
            progress: progress.percent
        });
    })
    .on('end', function() {
        fs.unlink(inputFile);
        convertEmitter.emit('convert-end');
    })
    .save(outputFile);

    return convertEmitter;
};

/**
* Get infos about an online video with youtube-dl
* @param url
* @return Promise
*/
at3.getInfosWithYoutubeDl = function(url) {
    return new Promise(function (resolve, reject) {
        youtubedl.getInfo(url, function (err, infos) {
            resolve({
                title: infos.title,
                author: infos.uploader,
                picture: infos.thumbnail
            });
        });
    });
};

/**
* Download a single URL in MP3
* @param url
* @param outputFile
* @param bitrate
* @return Event
*/
at3.downloadSingleURL = function(url, outputFile, bitrate) {
    const progressEmitter = new EventEmitter();
    var tempFile = outputFile + '.video';

    var dl = at3.downloadWithYoutubeDl(url, tempFile);

    dl.on('download-start', function() {
        progressEmitter.emit('start');
    });
    dl.on('download-progress', function(infos) {
        progressEmitter.emit('download', {
            progress: infos.progress
        });
    });

    dl.on('download-end', function() {
        progressEmitter.emit('download-end');

        var convert = at3.convertInMP3(tempFile, outputFile, bitrate);

        convert.on('convert-progress', function(infos) {
            progressEmitter.emit('convert', {
                progress: infos.progress
            });
        });
        convert.on('convert-end', function() {
            progressEmitter.emit('end');
        });
    });

    return progressEmitter;
};

/**
* Try to find to title and artist from a string
* (example: a YouTube video title)
* @param query string
* @param exact boolean Can the query be modified or not
* @param last boolean Last call
* @param v boolean Verbose
* @return Promise
*/
at3.guessTrackFromString = function(query, exact, last, v) {
    if (exact === undefined) {
        exact = false;
    }
    if (last === undefined) {
        last = false;
    }
    if (v === undefined) {
        v = false;
    }

    if (v) {
        console.log("Query: ", query);
    }

    var searchq = query;
    if (!exact) {
        searchq = searchq.replace(/\(.*\)/g, '');
        searchq = searchq.replace(/\[.*\]/g, '');
        searchq = searchq.replace(/lyric(s?)|parole(s?)/ig, '');
    }

    var requests = [];
    var infos = {
        title: null,
        artistName: null,
    };

    // We search on Echonest, Deezer and iTunes
    // Echonest
    var requestEchonest = request({
        url: 'http://developer.echonest.com/api/v4/song/search?api_key=' + API_ECHONEST_KEY + '&format=json&results=10&bucket=id:7digital-US&bucket=audio_summary&bucket=tracks&combined=' + encodeURIComponent(searchq),
        json: true
    }).then(function (body) {
        var title, artistName, tempTitle;
        _.forEach(body.response.songs, function (s) {
            if (!title) {
                if (vsimpleName(searchq, exact).match(new RegExp(vsimpleName(s.artist_name), 'ig'))) {
                    if (delArtist(s.artist_name, searchq, exact).match(new RegExp(vsimpleName(s.title), 'ig'))) {
                        artistName = s.artist_name;
                        title = s.title;
                    } else if (!artistName) {
                        artistName = s.artist_name;
                        tempTitle = s.title;
                    }
                }
            }
        });
        if (title && artistName) {
            infos.title = title;
            infos.artistName = artistName;
        }
        if (v) {
            console.log("Echonest answer: ", title, '-', artistName);
        }
    });

    // Deezer
    var requestDeezer = request({
        url: 'http://api.deezer.com/2.0/search?q=' + encodeURIComponent(searchq),
        json: true
    }).then(function (body) {
        var title, artistName, tempTitle;
        _.forEach(body.data, function (s) {
            if (!title) {
                if (vsimpleName(searchq,exact).replace(new RegExp(vsimpleName(s.artist.name), 'ig'))) {
                    if (delArtist(s.artist.name, searchq, exact).match(new RegExp(vsimpleName(s.title), 'ig')) || vsimpleName(s.title).match(new RegExp(delArtist(s.artist.name, searchq, exact), 'ig'))) {
                        artistName = s.artist.name;
                        title = s.title;
                    } else if(!artistName) {
                        artistName = s.artist.name;
                        tempTitle = s.title;
                    }
                }
            }
        });
        if (title && artistName) {
            infos.title = title;
            infos.artistName = artistName;
        }
        if (v) {
            console.log("Deezer answer: ", title, '-', artistName);
        }
    });

    // iTunes
    var requestiTunes = request({
        url: 'https://itunes.apple.com/search?media=music&term=' + encodeURIComponent(searchq),
        json: true
    }).then(function (body) {
        var title, artistName, tempTitle;
        _.forEach(body.results, function (s) {
            if (!title) {
                if (vsimpleName(searchq, exact).match(new RegExp(vsimpleName(s.artistName), 'gi'))) {
                    if (delArtist(s.artistName, searchq, exact).match(new RegExp(vsimpleName(s.trackName), 'gi'))) {
                        artistName = s.artistName;
                        title = s.trackName;
                    } else if(delArtist(s.artistName, searchq, exact).match(new RegExp(vsimpleName(s.trackCensoredName), 'gi'))) {
                        artistName = s.artistName;
                        title = s.trackCensoredName;
                    } else if(!artistName) {
                        artistName = s.artistName;
                        temp_title = s.trackName;
                    }
                }
            }
        });
        if (title && artistName) {
            infos.title = title;
            infos.artistName = artistName;
        }
        if (v) {
            console.log("iTunes answer: ", title, '-', artistName);
        }
    });

    requests.push(requestEchonest);
    requests.push(requestDeezer);
    requests.push(requestiTunes);

    return Promise.all(requests).then(function() {
        if (!last && (!infos.title || !infos.artistName)) {
            searchq = searchq.replace(/f(ea)?t(\.)? [^-]+/ig,' ');
            return at3.guessTrackFromString(searchq, false, true, v);
        }
        return infos;
    });

};

/**
* Try to guess title and artist from mp3 file
* @param file
* @return Promise
*/
at3.guessTrackFromFile = function (file) {
    return new Promise(function (resolve, reject) {
        acoustid(file, { key: API_ACOUSTID }, function (err, results) {
            if (err || results.length === 0 || !results[0].recordings || results[0].recordings.length === 0 || !results[0].recordings[0].artists || results[0].recordings[0].artists.length === 0) {
                resolve({});
                return;
            }
            resolve({
                title: results[0].recordings[0].title,
                artistName: results[0].recordings[0].artists[0].name
            });
        });
    });
};


/**
* Retrieve informations about a track from artist and title
* @param title
* @param artistName
* @param exact boolean Exact search or not
* @param v boolean Verbose
* @return Promise
*/
at3.retrieveTrackInformations = function (title, artistName, exact, v) {
    if (exact === undefined) {
        exact = false;
    }
    if (v === undefined) {
        v = false;
    }

    if (!exact) {
        title = title.replace(/((\[)|(\())?radio edit((\])|(\)))?/ig, '');
    }

    var infos = {
        title: title,
        artistName: artistName
    };

    var requests = [];

    var requestDeezer = request({
        url: 'http://api.deezer.com/2.0/search?q=' + encodeURIComponent(artistName + ' ' + title),
        json: true
    }).then(function (body) {
        var deezerInfos;
        _.forEach(body.data, function (s) {
            if(!infos.deezerId && imatch(vsimpleName(title), vsimpleName(s.title)) && imatch(vsimpleName(artistName), vsimpleName(s.artist.name))) {
                infos.deezerId = s.id;
                deezerInfos = _.clone(s);
            }
        });
        if (infos.deezerId) {
            infos.artistName = deezerInfos.artist.name;
            infos.title = deezerInfos.title;

            return at3.getDeezerTrackInfos(infos.deezerId, v).then(function (deezerInfos) {
                infos = deezerInfos;
            });
        }
    });

    var requestiTunes = request({
        url: 'https://itunes.apple.com/search?media=music&term=' + encodeURIComponent(artistName + ' ' + title),
        json: true
    }).then(function (body) {
        var itunesInfos;
        _.forEach(body.results, function (s) {
            if (!infos.itunesId && (imatch(vsimpleName(title), vsimpleName(s.trackName)) || imatch(vsimpleName(title), vsimpleName(s.trackCensoredName))) && imatch(vsimpleName(artistName), vsimpleName(s.artistName))) {
                infos.itunesId = s.trackId;
                itunesInfos = _.clone(s);
            }
        });
        if (!infos.deezerId && itunesInfos) {
            infos.artistName = itunesInfos.artistName;
            if (imatch(vsimpleName(infos.title), vsimpleName(itunesInfos.trackName))) {
                infos.title = itunesInfos.trackName;
            } else {
                infos.title = itunesInfos.trackCensoredName;
            }
            infos.itunesAlbum = itunesInfos.collectionId;
            infos.position = itunesInfos.trackNumber;
            infos.nbTracks = itunesInfos.trackCount;
            infos.album = itunesInfos.collectionName;
            infos.releaseDate = itunesInfos.releaseDate.replace(/T.+/, '');
            infos.cover = itunesInfos.artworkUrl100.replace('100x100', '200x200');
            infos.genre = itunesInfos.primaryGenreName;
            infos.discNumber = itunesInfos.discNumber;
            infos.duration = itunesInfos.trackTimeMillis/1000;
        }

        if (v) {
            console.log("iTunes infos: ", itunesInfos);
        }
    });

    requests.push(requestDeezer);
    requests.push(requestiTunes);

    return Promise.all(requests).then(function () {
        return infos;
    });
};

/**
* Retrieve detailed infos about a Deezer Track
* @param trackId
* @param v boolean Verbosity
* @return Promise(trackInfos)
*/
at3.getDeezerTrackInfos = function(trackId, v) {
    var infos = {
        deezerId : trackId
    };

    return request({
        url: 'http://api.deezer.com/2.0/track/' + infos.deezerId,
        json: true
    }).then(function (trackInfos) {
        infos.title = trackInfos.title;
        infos.artistName = trackInfos.artist.name;
        infos.position = trackInfos.track_position;
        infos.duration = trackInfos.duration;
        infos.deezerAlbum = trackInfos.album.id;
        infos.discNumber = trackInfos.disk_number;

        return request({
            url: 'http://api.deezer.com/2.0/album/' + infos.deezerAlbum,
            json: true
        });
    }).then(function (albumInfos) {
        infos.album = albumInfos.title;
        infos.releaseDate = albumInfos.release_date;
        infos.nbTracks = albumInfos.tracks.data.length;
        infos.genreId = albumInfos.genre_id;
        infos.cover = albumInfos.cover_big;

        return request({
            url: 'http://api.deezer.com/2.0/genre/' + infos.genreId,
            json: true
        });
    }).then(function (genreInfos) {
        infos.genre = genreInfos.name;

        if (v) {
            console.log("Deezer infos: ", infos);
        }

        return infos;
    });
};

/**
* Add tags to MP3 file
* @param file
* @param infos
* @return Promise
*/
at3.tagFile = function (file, infos) {
    var meta = {
        title: infos.title,
        artist: infos.artistName
    };
    if (infos.album) {
        meta.album = infos.album;
    }
    if (infos.position) {
        meta.track = infos.position;
    }
    if (infos.nbTracks) {
        meta.trackTotal = infos.nbTracks;
    }
    if (infos.discNumber) {
        meta.disc = infos.discNumber;
    }
    if (infos.lyrics) {
        meta.lyrics = infos.lyrics;
    }
    if (infos.releaseDate) {
        meta.year = (/[0-9]{4}/.exec(infos.releaseDate))[0];
    }
    if (infos.genre) {
        meta.genre = infos.genre.replace(/\/.+/g, '');
    }

    return new Promise(function (resolve, reject) {
        eyed3.updateMeta(file, meta, function (err) {
            if (err) {
                console.log(err);
            }
            if (infos.cover) {
                var coverPath = file + '.cover.jpg';

                requestNoPromise(infos.cover, function () {
                    eyed3.updateMeta(file, {image: coverPath}, function (err) {
                        if (err) {
                            console.log("image error: ", err);
                        }
                        fs.unlinkSync(coverPath);

                        resolve();
                    });
                }).pipe(fs.createWriteStream(coverPath));
            } else {
                resolve();
            }
        });
    });

};

/**
* Download and convert a single URL,
* retrieve and add tags to the MP3 file
* @param url
* @param outputFolder
* @param callback Callback function
* @param title string Optional requested title
* @param v boolean Verbosity
* @return Event
*/
at3.downloadAndTagSingleURL = function (url, outputFolder, callback, title, v) {
    if (v === undefined) {
        v = false;
    }
    if (callback === undefined) {
        callback = function() {};
    }
    if (outputFolder.charAt(outputFolder.length-1) != '/') {
        outputFolder += '/';
    }

    const progressEmitter = new EventEmitter();

    var tempFile = outputFolder + crypto.createHash('sha256').update(url).digest('hex') + '.mp3';

    // Download and convert file
    var dl = at3.downloadSingleURL(url, tempFile, '320k');
    dl.on('download', function(infos) {
        progressEmitter.emit('download', infos);
    });
    dl.on('download-end', function() {
        progressEmitter.emit('download-end');
    });
    dl.on('convert', function(infos) {
        progressEmitter.emit('convert', infos, infos);
    });

    var infosFromString, infosFromFile;

    // Try to find information based on video title
    var getStringInfos = at3.getInfosWithYoutubeDl(url).then(function(videoInfos) {
        infosFromString = {
            title: videoInfos.title,
            artistName: videoInfos.author,
            cover: videoInfos.picture // [TODO] Create square image
        };

        if (title === undefined) {
            title = videoInfos.title;
        }

        if (v) {
            console.log("Video infos: ", infosFromString);
        }

        progressEmitter.emit('infos', _.clone(infosFromString));

        return at3.guessTrackFromString(videoInfos.title, false, false, v);
    }).then(function (guessStringInfos) {
        if (guessStringInfos.title && guessStringInfos.artistName) {
            return at3.retrieveTrackInformations(guessStringInfos.title, guessStringInfos.artistName, false, v);
        } else {
            return Promise.resolve();
        }
    }).then(function (guessStringInfos) {
        if (guessStringInfos) {
            infosFromString = guessStringInfos;
            progressEmitter.emit('infos', _.clone(infosFromString));
            if (v) {
                console.log("guessStringInfos: ", guessStringInfos);
            }
        } else {
            if (v) {
                console.log('Cannot retrieve detailed information from video title');
            }
        }
    });

    // Try to find information based on MP3 file when dl is finished
    dl.once('end', function() {
        progressEmitter.emit('convert-end');
        var getFileInfos = at3.guessTrackFromFile(tempFile).then(function (guessFileInfos) {
            if (guessFileInfos.title && guessFileInfos.artistName) {
                return at3.retrieveTrackInformations(guessFileInfos.title, guessFileInfos.artistName, false, v);
            } else {
                return Promise.resolve();
            }
        }).then(function (guessFileInfos) {
            if (guessFileInfos) {
                infosFromFile = guessFileInfos;
                if (v) {
                    console.log("guessFileInfos: ", guessFileInfos);
                }
            } else {
                if (v) {
                    console.log('Cannot retrieve detailed information from MP3 file');
                }
            }
        });

        // [TODO] Improve network issue resistance
        Promise.all([getStringInfos, getFileInfos]).then(function() {
            var infos = infosFromString;
            if (infosFromFile) {
                var scoreFromFile = Math.min(
                    levenshtein.get(simpleName(infosFromFile.title + ' ' + infosFromFile.artistName), simpleName(title)),
                    levenshtein.get(simpleName(infosFromFile.artistName + ' ' + infosFromFile.title), simpleName(title))
                );
                var scoreFromString = Math.min(
                    levenshtein.get(simpleName(infosFromString.title + ' ' + infosFromString.artistName), simpleName(title)),
                    levenshtein.get(simpleName(infosFromString.artistName + ' ' + infosFromString.title), simpleName(title))
                );

                if (v) {
                    console.log("Infos from file score: ", scoreFromFile);
                    console.log("Infos from string score: ", scoreFromString);
                }

                if (infosFromFile.cover && scoreFromFile < (scoreFromString + Math.ceil(simpleName(title).length/10.0))) {
                    infos = infosFromFile;
                }
            }

            progressEmitter.emit('infos', _.clone(infos));

            if (v) {
                console.log('Final infos: ', infos);
            }

            at3.findLyrics(infos.title, infos.artistName).then(function(lyrics) {
                return fs.writeFile(tempFile + '.lyrics', lyrics);
            }).then(function() {
                infos.lyrics = tempFile + '.lyrics';
            }).catch(function() {
                // no lyrics
            }).finally(function() {
                return at3.tagFile(tempFile, infos);
            }).then(function() {
                var finalFile = outputFolder + infos.artistName + ' - ' + infos.title + '.mp3';
                fs.renameSync(tempFile, finalFile);
                fs.unlink(tempFile + '.lyrics');
                var finalInfos = {
                    infos: infos,
                    file: finalFile
                };
                progressEmitter.emit('end', finalInfos);
                callback(finalInfos);
            });
        });
    });

    return progressEmitter;
};

/**
* Try to find the best video matching a request
* @param query string
* @param v boolean Verbosity
* @return Promise
*/
at3.findVideo = function(query, v) {
    if (v === undefined) {
        v = false;
    }

    /**
    * Remove useless information in the title
    * like (audio only), (lyrics)...
    * @param title string
    * @return string
    */
    function improveTitle(title) {
        var useless = [
            'audio only',
            'audio',
            'paroles/lyrics',
            'lyrics/paroles',
            'with lyrics',
            'w/lyrics',
            'w / lyrics',
            'avec paroles',
            'avec les paroles',
            'avec parole',
            'lyrics',
            'paroles',
            'parole',
            'radio edit.',
            'radio edit',
            'radio-edit',
            'shazam version',
            'shazam v...',
            'music video',
            'clip officiel',
            'officiel',
            'new song',
            'official video',
            'official'
        ];

        _.forEach(useless, function (u) {
            title = title.replace(new RegExp('((\\\(|\\\[)?)( ?)' + u + '( ?)((\\\)|\\\])?)', 'gi'), '');
        });

        title = title.replace(new RegExp('(\\\(|\\\[)( ?)hd( ?)(\\\)|\\\])', 'gi'), '');
        title = title.replace(new RegExp('hd','gi'), '');
        title = _.trim(title);

        return title;
    }

    /**
    * Returns an ISO 8601 Time as PT3M6S (=3min and 6seconds)
    * in seconds
    */
    function parseTime(time) {
        time = time.replace('PT','');
        time = time.replace('S', '');
        if (/M/.test(time)) {
            time = time.split('M');
            return (parseInt(time[0])*60 + parseInt(time[1]));
        } else {
            return parseInt(time[0]);
        }
    }

    /**
    * Modify strings to compare it more efficently
    * example: Maître Gims = maitre gims
    * @param text string
    * @return string
    */
    function easyCompare(text) {
        return _.deburr(_.toLower(text));
    }

    /**
    * Returns the score of a video, comparing to the request
    * @param q string The query
    * @param video object
    * @param largestRealLike
    * @param largestViews
    * @return Object
    */
    function score(q, video, largestRealLike, largestViews, guessSong) {
        // weight of each argument
        var weights = {
            title: 20,
            hd: 0.3,
            duration: 14,
            views: 10,
            realLike: 100
        };

        var duration = guessSong.duration || video.duration;

        var easyQ = easyCompare(q);

        // Score for title
        var title = _.toLower(video.title);
        var stitle;
        if (title.split(' - ').length == 1) {
            var expTitle = title.split(' - ');
            var title2 = expTitle[1] + ' - ' + expTitle[0];
            sTitle = Math.min(levenshtein.get(easyQ, easyCompare(title)), levenshtein.get(easyQ, easyCompare(title2)));
        } else {
            sTitle = levenshtein.get(easyQ, easyCompare(title));
        }

        var videoScore = {
            title: sTitle*weights.title,
            hd: video.hd*weights.hd,
            duration: Math.abs(video.duration - duration)*weights.duration,
            views: (video.views/largestViews)*weights.views,
            realLike: (video.realLike/largestRealLike)*weights.realLike
        };

        var preVideoScore = videoScore.views + videoScore.realLike - videoScore.title - videoScore.duration;
        preVideoScore = preVideoScore + Math.abs(preVideoScore)*videoScore.hd;

        return preVideoScore;
    }

    return new Promise(function (resolve, reject) {

        // We try to find the exact song
        // (usefull to compare the duration for example)
        var guessSong = {};
        var guessSongRequest = at3.guessTrackFromString(query, false, false, v).then(function (guessStringInfos) {
            if (guessStringInfos.title && guessStringInfos.artistName) {
                return at3.retrieveTrackInformations(guessStringInfos.title, guessStringInfos.artistName, false, v);
            } else {
                return Promise.resolve({});
            }
        }).then(function(guessStringInfos) {
            guessSong = guessStringInfos;
        });

        var results = [];

        // We simply search on YouTube
        var requestYouTubeSearch = request({
            url: 'https://www.googleapis.com/youtube/v3/search?part=snippet&key=' + API_GOOGLE + '&maxResults=7&q=' + encodeURIComponent(query),
            json: true
        }).then(function (body) {
            if (!body.items || body.items.length === 0) {
                return reject();
            }

            var requests = [guessSongRequest];

            _.forEach(body.items, function (s) {
                if (!s.id.videoId) {
                    return;
                }

                var req = request({
                    url: 'https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&key=' + API_GOOGLE + '&id=' + s.id.videoId,
                    json: true
                }).then(function (video) {
                    video = video.items[0];
                    var ratio = 1.0;
                    if (video.statistics.dislikeCount > 0) {
                        ratio = video.statistics.likeCount / video.statistics.dislikeCount;
                    }
                    if (ratio === 0) {
                        ratio = 1;
                    }
                    var realLike = (video.statistics.likeCount - video.statistics.dislikeCount) * ratio;

                    results.push({
                        id: video.id,
                        url: 'https://www.youtube.com/watch?v=' + video.id,
                        title: improveTitle(video.snippet.title),
                        hd: (video.contentDetails.definition == 'hd'),
                        duration: parseTime(video.contentDetails.duration),
                        views: video.statistics.viewCount,
                        realLike: realLike
                    });
                });

                requests.push(req);
            });

            return Promise.all(requests);
        }).then(function () {

            var largestRealLike = _.reduce(results, function (v, r) {
                if (r.realLike > v) {
                    return r.realLike;
                }
                return v;
            }, 0);
            var largestViews = _.reduce(results, function (v, r) {
                if (r.views > v) {
                    return r.views;
                }
                return v;
            }, 0);

            _.forEach(results, function(r) {
                r.score = score(query, r, largestRealLike, largestViews, guessSong);
            });

            resolve(_.reverse(_.sortBy(results, 'score')));
        });

    });
};

/**
* Find a song from a query, then download the corresponding video,
* convert and tag it
* @param query string
* @param outputFolder
* @param callback Callback function
* @param v boolean Verbosity
* @return Event
*/
at3.findAndDownload = function(query, outputFolder, callback, v) {
    if (v === undefined) {
        v = false;
    }
    const progressEmitter = new EventEmitter();

    at3.findVideo(query).then(function(results) {
        if (results.length === 0) {
            progressEmitter.emit('error');
            return callback(null, "Cannot find any video corresponding");
        }
        progressEmitter.emit('search-end');
        var dl = at3.downloadAndTagSingleURL(results[0].url, outputFolder, callback, query);
        dl.on('download', function(infos) {
            progressEmitter.emit('download', infos);
        });
        dl.on('download-end', function() {
            progressEmitter.emit('download-end');
        });
        dl.on('convert', function(infos) {
            progressEmitter.emit('convert', infos);
        });
        dl.on('convert-end', function() {
            progressEmitter.emit('convert-end');
        });
        dl.on('infos', function(infos) {
            progressEmitter.emit('infos', infos);
        });
    });

    return progressEmitter;
};

/**
* Return URLs contained in a playlist (YouTube or SoundCloud)
* @param url
* @return Promise(array({url: url}))
*/
at3.getURLsInPlaylist = function(url) {
    var type = at3.guessURLType(url);
    if (type == 'youtube') {
        var playlistId = url.match(/list=([0-9a-zA-Z_-]+)/);
        playlistId = playlistId[1];
        return request({
            url: 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&key=' + API_GOOGLE + '&maxResults=50&playlistId=' + playlistId,
            json: true
        }).then(function (playlistDetails) {
            var playlistItems = [];

            _.forEach(playlistDetails.items, function (item) {
                var highestUrl;
                _.forEach(['maxres', 'standart', 'high', 'medium', 'default'], function (res) {
                    if (!highestUrl && item.snippet.thumbnails[res]) {
                        highestUrl = item.snippet.thumbnails[res].url;
                    }
                });
                playlistItems.push({
                    url: 'http://youtube.com/watch?v=' + item.snippet.resourceId.videoId,
                    title: item.snippet.title,
                    image: highestUrl
                });
            });

            return playlistItems;
        });
    } else if (type == 'soundcloud') {
        return request({
            url: 'http://api.soundcloud.com/resolve?client_id=' + API_SOUNDCLOUD + '&url=' + url,
            json: true
        }).then(function (playlistDetails) {
            var playlistItems = [];

            _.forEach(playlistDetails.tracks, function (track) {
                playlistItems.push({
                    url: track.permalink_url,
                    title: track.title,
                    image: track.artwork_url
                });
            });

            return playlistItems;
        });
    }
};

/**
* Returns songs in a playlist (Deezer or Spotify)
* @param url
* @return Promise(array(trackInfos))
*/
at3.getTracksInPlaylist = function(url) {
    // Deezer Playlist
    // Deezer Album
    // Deezer Loved Tracks
    // Spotify playlist
    var type = at3.guessURLType(url);

    var regDeezerPlaylist = /playlist\/([0-9]+)$/;
    var regDeezerAlbum = /album\/([0-9]+)$/;

    if (type == 'deezer') {
        // Deezer Playlist
        if (regDeezerPlaylist.test(url)) {
            var playlistId = url.match(regDeezerPlaylist)[1];

            return request({
                url: 'http://api.deezer.com/playlist/' + playlistId,
                json: true
            }).then(function (playlistDetails) {
                var tracks = [];

                _.forEach(playlistDetails.tracks.data, function (track) {
                    tracks.push({
                        title: track.title,
                        artistName: track.artist.name,
                        deezerId: track.id,
                        album: track.album.title,
                        cover: track.album.cover_big
                    });
                });

                return tracks;
            });
        } else if (regDeezerAlbum.test(url)) {
            var albumId = url.match(regDeezerAlbum)[1];
            var albumInfos = {};

            return request({
                url: 'http://api.deezer.com/album/' + albumId,
                json: true
            }).then(function (ralbumInfos) {
                albumInfos.cover = ralbumInfos.cover_big;
                albumInfos.album = ralbumInfos.title;

                return request({
                    url: 'http://api.deezer.com/album/' + albumId + '/tracks',
                    json: true
                });
            }).then(function (albumTracks) {
                var tracks = [];

                _.forEach(albumTracks.data, function (track) {
                    tracks.push({
                        title: track.title,
                        artistName: track.artist.name,
                        deezerId: track.id,
                        album: albumInfos.album,
                        cover: albumInfos.cover
                    });
                });

                return tracks;
            });
        }
    }
};

/**
* Return URL type
* @param url
* @return string
*/
at3.guessURLType = function(url) {
    if (/^(https?:\/\/)?((www|m)\.)?((youtube\.([a-z]{2,4}))|(youtu\.be))/.test(url)) {
        return 'youtube';
    } else if (/^(https?:\/\/)?(((www)|(m))\.)?(soundcloud\.([a-z]{2,4}))/.test(url)) {
        return 'soundcloud';
    } else if (/^(https?:\/\/)?(www\.)?(deezer\.([a-z]{2,4}))\//.test(url)) {
        return 'deezer';
    }
};

function imatch(textSearched, text) {
    // [TODO] Improve this function (use .test and espace special caracters + use it everywhere else)
    return text.match(new RegExp(textSearched, 'gi'));
}
function vsimpleName(text, exact) {
    if (exact === undefined) {
        exact = false;
    }
    text = text.toLowerCase();
    if (!exact) {
        // text = text.replace('feat', '');
    }
    text = text.replace(/((\[)|(\())?radio edit((\])|(\)))?/ig, '');
    text = text.replace(/[^a-zA-Z0-9]/ig, '');
    return text;
}
function delArtist(artist, text, exact) {
    if (exact === undefined) {
        exact = false;
    }
    if(vsimpleName(artist).length <= 2) { // Artist with a very short name (Mathieu Chedid - M)
        return vsimpleName(text, exact);
    } else {
        // [TODO] Improve, escape regex special caracters in vsimpleName(artist)
        return vsimpleName(text, exact).replace(new RegExp(vsimpleName(artist),'ig'), '');
    }
}
function simpleName(text) {
    return text.replace(/\(.+\)/g, '');
}

module.exports = at3;
