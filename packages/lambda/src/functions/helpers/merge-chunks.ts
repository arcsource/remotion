import type {AudioCodec, LogLevel} from '@remotion/renderer';
import fs from 'fs';
import type {CustomCredentials} from '../../shared/aws-clients';
import {
	cleanupSerializedInputProps,
	cleanupSerializedResolvedProps,
} from '../../shared/cleanup-serialized-input-props';
import type {
	PostRenderData,
	Privacy,
	RenderMetadata,
	SerializedInputProps,
} from '../../shared/constants';
import {
	encodingProgressKey,
	initalizedMetadataKey,
	rendersPrefix,
} from '../../shared/constants';
import type {DownloadBehavior} from '../../shared/content-disposition-header';
import type {LambdaCodec} from '../../shared/validate-lambda-codec';
import {concatVideos} from './concat-videos';
import {createPostRenderData} from './create-post-render-data';
import {cleanupFiles} from './delete-chunks';
import {getCurrentRegionInFunction} from './get-current-region';
import {getEncodingProgressStepSize} from './get-encoding-progress-step-size';
import {getFilesToDelete} from './get-files-to-delete';
import {getOutputUrlFromMetadata} from './get-output-url-from-metadata';
import {inspectErrors} from './inspect-errors';
import {lambdaDeleteFile, lambdaLs, lambdaWriteFile} from './io';
import {lambdaRenderHasAudioVideo} from './render-has-audio-video';
import {timer} from './timer';
import {writeLambdaError} from './write-lambda-error';
import {writePostRenderData} from './write-post-render-data';

export const mergeChunksAndFinishRender = async (options: {
	bucketName: string;
	renderId: string;
	expectedBucketOwner: string;
	numberOfFrames: number;
	codec: LambdaCodec;
	chunkCount: number;
	fps: number;
	numberOfGifLoops: number | null;
	audioCodec: AudioCodec | null;
	renderBucketName: string;
	customCredentials: CustomCredentials | null;
	downloadBehavior: DownloadBehavior;
	key: string;
	privacy: Privacy;
	inputProps: SerializedInputProps;
	serializedResolvedProps: SerializedInputProps;
	renderMetadata: RenderMetadata;
	audioBitrate: string | null;
	logLevel: LogLevel;
	framesPerLambda: number;
	binariesDirectory: string | null;
	preferLossless: boolean;
	compositionStart: number;
	outdir: string;
	files: string[];
}): Promise<PostRenderData> => {
	let lastProgressUploaded = Date.now();

	const onProgress = (framesEncoded: number) => {
		const deltaSinceLastProgressUploaded = Date.now() - lastProgressUploaded;

		if (
			deltaSinceLastProgressUploaded < 1500 &&
			framesEncoded !== options.numberOfFrames
		) {
			return;
		}

		lastProgressUploaded = Date.now();

		lambdaWriteFile({
			bucketName: options.bucketName,
			key: encodingProgressKey(options.renderId),
			body: String(
				Math.round(
					framesEncoded / getEncodingProgressStepSize(options.numberOfFrames),
				),
			),
			region: getCurrentRegionInFunction(),
			privacy: 'private',
			expectedBucketOwner: options.expectedBucketOwner,
			downloadBehavior: null,
			customCredentials: null,
		}).catch((err) => {
			writeLambdaError({
				bucketName: options.bucketName,
				errorInfo: {
					chunk: null,
					frame: null,
					isFatal: false,
					name: (err as Error).name,
					message: (err as Error).message,
					stack: `Could not upload stitching progress ${
						(err as Error).stack as string
					}`,
					tmpDir: null,
					type: 'stitcher',
					attempt: 1,
					totalAttempts: 1,
					willRetry: false,
				},
				renderId: options.renderId,
				expectedBucketOwner: options.expectedBucketOwner,
			});
		});
	};

	const {hasAudio, hasVideo} = lambdaRenderHasAudioVideo(
		options.renderMetadata,
	);

	// TODO: Add back get files

	const encodingStart = Date.now();
	if (options.renderMetadata.type === 'still') {
		throw new Error('Cannot merge stills');
	}

	const {outfile, cleanupChunksProm} = await concatVideos({
		onProgress,
		numberOfFrames: options.numberOfFrames,
		codec: options.codec,
		fps: options.fps,
		numberOfGifLoops: options.numberOfGifLoops,
		files: options.files,
		outdir: options.outdir,
		audioCodec: options.audioCodec,
		audioBitrate: options.audioBitrate,
		logLevel: options.logLevel,
		framesPerLambda: options.framesPerLambda,
		binariesDirectory: options.binariesDirectory,
		cancelSignal: undefined,
		preferLossless: options.preferLossless,
		muted: options.renderMetadata.muted,
	});
	const encodingStop = Date.now();

	const outputSize = fs.statSync(outfile);

	const writeToS3 = timer(
		`Writing to S3 (${outputSize.size} bytes)`,
		options.logLevel,
	);

	await lambdaWriteFile({
		bucketName: options.renderBucketName,
		key: options.key,
		body: fs.createReadStream(outfile),
		region: getCurrentRegionInFunction(),
		privacy: options.privacy,
		expectedBucketOwner: options.expectedBucketOwner,
		downloadBehavior: options.downloadBehavior,
		customCredentials: options.customCredentials,
	});

	writeToS3.end();

	const contents = await lambdaLs({
		bucketName: options.bucketName,
		prefix: rendersPrefix(options.renderId),
		expectedBucketOwner: options.expectedBucketOwner,
		region: getCurrentRegionInFunction(),
	});

	const finalEncodingProgressProm = lambdaWriteFile({
		bucketName: options.bucketName,
		key: encodingProgressKey(options.renderId),
		body: String(
			Math.ceil(
				options.numberOfFrames /
					getEncodingProgressStepSize(options.numberOfFrames),
			),
		),
		region: getCurrentRegionInFunction(),
		privacy: 'private',
		expectedBucketOwner: options.expectedBucketOwner,
		downloadBehavior: null,
		customCredentials: null,
	});

	const errorExplanationsProm = inspectErrors({
		contents,
		renderId: options.renderId,
		bucket: options.bucketName,
		region: getCurrentRegionInFunction(),
		expectedBucketOwner: options.expectedBucketOwner,
	});

	const jobs = getFilesToDelete({
		chunkCount: options.chunkCount,
		renderId: options.renderId,
		hasAudio,
		hasVideo,
	});

	const deletProm =
		options.logLevel === 'verbose'
			? Promise.resolve(0)
			: cleanupFiles({
					region: getCurrentRegionInFunction(),
					bucket: options.bucketName,
					contents,
					jobs,
				});

	const cleanupSerializedInputPropsProm = cleanupSerializedInputProps({
		bucketName: options.bucketName,
		region: getCurrentRegionInFunction(),
		serialized: options.inputProps,
	});
	const cleanupResolvedInputPropsProm = cleanupSerializedResolvedProps({
		bucketName: options.bucketName,
		region: getCurrentRegionInFunction(),
		serialized: options.serializedResolvedProps,
	});

	const {url: outputUrl} = getOutputUrlFromMetadata(
		options.renderMetadata,
		options.bucketName,
		options.customCredentials,
	);

	const postRenderData = createPostRenderData({
		expectedBucketOwner: options.expectedBucketOwner,
		region: getCurrentRegionInFunction(),
		renderId: options.renderId,
		memorySizeInMb: Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE),
		renderMetadata: options.renderMetadata,
		contents,
		errorExplanations: await errorExplanationsProm,
		timeToEncode: encodingStop - encodingStart,
		timeToDelete: (
			await Promise.all([
				deletProm,
				cleanupSerializedInputPropsProm,
				cleanupResolvedInputPropsProm,
			])
		).reduce((a, b) => a + b, 0),
		outputFile: {
			lastModified: Date.now(),
			size: outputSize.size,
			url: outputUrl,
		},
	});

	await finalEncodingProgressProm;
	await writePostRenderData({
		bucketName: options.bucketName,
		expectedBucketOwner: options.expectedBucketOwner,
		postRenderData,
		region: getCurrentRegionInFunction(),
		renderId: options.renderId,
	});
	await lambdaDeleteFile({
		bucketName: options.bucketName,
		key: initalizedMetadataKey(options.renderId),
		region: getCurrentRegionInFunction(),
		customCredentials: null,
	});

	await Promise.all([cleanupChunksProm, fs.promises.rm(outfile)]);
	return postRenderData;
};
