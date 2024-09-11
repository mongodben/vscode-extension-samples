import { renderPrompt } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { PlayPrompt } from './play';
import { styleGuide } from './styleGuide';

const SG_COMMAND_ID = 'styleGandalf.check';
const SG_PARTICIPANT_ID = 'style-gandalf.styleGandalf';

interface ICatChatResult extends vscode.ChatResult {
	metadata: {
		command: string;
	};
}

// Use gpt-4o since it is fast and high quality. gpt-3.5-turbo and gpt-4 are also available.
const MODEL_SELECTOR: vscode.LanguageModelChatSelector = {
	vendor: 'copilot',
	family: 'gpt-4o',
};

const META_SYSTEM_PROMPT = `You are an expert technical editor named Gandalf who's role is to help technical writers at MongoDB.

You are communicating with the user via a Github Copilot extension in VS Code.
The MongoDB documentation is written in reStructuredText (rST). Format your suggestions with rST syntax.

Use this style guide to inform your responses. When asked to create documentation, follow this style guide.

${styleGuide}`;
export function activate(context: vscode.ExtensionContext) {
	// Define a Cat chat handler
	const handler: vscode.ChatRequestHandler = async (
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<ICatChatResult> => {
		const editorContextMessage = getEditorContextMessage();

		// To talk to an LLM in your subcommand handler implementation, your
		// extension can use VS Code's `requestChatAccess` API to access the Copilot API.
		// The GitHub Copilot Chat extension implements this provider.
		if (request.command === 'check') {
			stream.progress('Picking the right topic to teach...');

			try {
				// To get a list of all available models, do not pass any selector to the selectChatModels.
				const [model] = await vscode.lm.selectChatModels(MODEL_SELECTOR);
				if (model) {
					const messages = [
						vscode.LanguageModelChatMessage.User(`${META_SYSTEM_PROMPT}
							Check if the text is in line with the MongoDB documentation style guide.`),
						editorContextMessage,
						vscode.LanguageModelChatMessage.User(request.prompt),
					];
					console.log('messages::', messages);

					const chatResponse = await model.sendRequest(messages, {}, token);
					for await (const fragment of chatResponse.text) {
						stream.markdown(fragment);
					}
				}
			} catch (err) {
				handleError(logger, err, stream);
			}

			stream.button({
				command: SG_COMMAND_ID,
				title: vscode.l10n.t('Use Style Guide in Editor'),
			});

			logger.logUsage('request', { kind: 'check' });
			return { metadata: { command: 'check' } };
		} else {
			try {
				const [model] = await vscode.lm.selectChatModels(MODEL_SELECTOR);
				if (model) {
					const messages = [
						vscode.LanguageModelChatMessage.User(`${META_SYSTEM_PROMPT}`),
						editorContextMessage,
						vscode.LanguageModelChatMessage.User(request.prompt),
					];

					const chatResponse = await model.sendRequest(messages, {}, token);
					for await (const fragment of chatResponse.text) {
						stream.markdown(fragment);
					}
				}
			} catch (err) {
				handleError(logger, err, stream);
			}

			logger.logUsage('request', { kind: '' });
			return { metadata: { command: '' } };
		}
	};

	// Chat participants appear as top-level options in the chat input
	// when you type `@`, and can contribute sub-commands in the chat input
	// that appear when you type `/`.
	const styleGandalf = vscode.chat.createChatParticipant(SG_PARTICIPANT_ID, handler);
	// TODO: see if want followups
	// styleGandalf.followupProvider = {
	// 	provideFollowups(
	// 		result: ICatChatResult,
	// 		context: vscode.ChatContext,
	// 		token: vscode.CancellationToken
	// 	) {
	// 		return [
	// 			// {
	// 			// 	prompt: 'let us play',
	// 			// 	label: vscode.l10n.t('Play with the cat'),
	// 			// 	command: 'play',
	// 			// } satisfies vscode.ChatFollowup,
	// 		];
	// 	},
	// };

	const logger = vscode.env.createTelemetryLogger({
		sendEventData(eventName, data) {
			// Capture event telemetry
			console.log(`Event: ${eventName}`);
			console.log(`Data: ${JSON.stringify(data)}`);
		},
		sendErrorData(error, data) {
			// Capture error telemetry
			console.error(`Error: ${error}`);
			console.error(`Data: ${JSON.stringify(data)}`);
		},
	});

	context.subscriptions.push(
		styleGandalf.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
			// Log chat result feedback to be able to compute the success matric of the participant
			// unhelpful / totalRequests is a good success metric
			logger.logUsage('chatResultFeedback', {
				kind: feedback.kind,
			});
		})
	);

	context.subscriptions.push(
		styleGandalf,
		// TODO: IDK what this does
		// Register the command handler for the /meow followup
		vscode.commands.registerTextEditorCommand(
			SG_COMMAND_ID,
			async (textEditor: vscode.TextEditor) => {
				// Replace all variables in active editor with cat names and words
				const text = textEditor.document.getText();

				let chatResponse: vscode.LanguageModelChatResponse | undefined;
				try {
					const [model] = await vscode.lm.selectChatModels(MODEL_SELECTOR);
					if (!model) {
						console.log(
							'Model not found. Please make sure the GitHub Copilot Chat extension is installed and enabled.'
						);
						return;
					}

					const messages = [
						vscode.LanguageModelChatMessage.User(`${META_SYSTEM_PROMPT}`),
						vscode.LanguageModelChatMessage.User(text),
					];
					chatResponse = await model.sendRequest(
						messages,
						{},
						new vscode.CancellationTokenSource().token
					);
				} catch (err) {
					if (err instanceof vscode.LanguageModelError) {
						console.log(err.message, err.code, err.cause);
					} else {
						throw err;
					}
					return;
				}

				// Clear the editor content before inserting new content
				await textEditor.edit((edit) => {
					const start = new vscode.Position(0, 0);
					const end = new vscode.Position(
						textEditor.document.lineCount - 1,
						textEditor.document.lineAt(
							textEditor.document.lineCount - 1
						).text.length
					);
					edit.delete(new vscode.Range(start, end));
				});

				// Stream the code into the editor as it is coming in from the Language Model
				try {
					for await (const fragment of chatResponse.text) {
						await textEditor.edit((edit) => {
							const lastLine = textEditor.document.lineAt(
								textEditor.document.lineCount - 1
							);
							const position = new vscode.Position(
								lastLine.lineNumber,
								lastLine.text.length
							);
							edit.insert(position, fragment);
						});
					}
				} catch (err) {
					// async response stream may fail, e.g network interruption or server side error
					await textEditor.edit((edit) => {
						const lastLine = textEditor.document.lineAt(
							textEditor.document.lineCount - 1
						);
						const position = new vscode.Position(
							lastLine.lineNumber,
							lastLine.text.length
						);
						edit.insert(position, (<Error>err).message);
					});
				}
			}
		)
	);
}

function handleError(
	logger: vscode.TelemetryLogger,
	err: any,
	stream: vscode.ChatResponseStream
): void {
	// making the chat request might fail because
	// - model does not exist
	// - user consent not given
	// - quote limits exceeded
	logger.logError(err);

	if (err instanceof vscode.LanguageModelError) {
		console.log(err.message, err.code, err.cause);
		if (err.cause instanceof Error && err.cause.message.includes('off_topic')) {
			stream.markdown(
				vscode.l10n.t("I'm sorry, I can only explain computer science concepts.")
			);
		}
	} else {
		// re-throw other errors so they show up in the UI
		throw err;
	}
}

function getEditorContextMessage() {
	const editorContext = getEditorContext();
	const editorContextMessage = vscode.LanguageModelChatMessage.User(
		`Use this context information from the editor to inform your response:
${editorContext}`
	);
	return editorContextMessage;
}

function getEditorContext() {
	const editor = vscode.window.activeTextEditor;
	let selectedText = '';

	if (editor) {
		const selection = editor.selection;
		if (!selection.isEmpty) {
			selectedText = `Current selected text:
		${editor.document.getText(selection)}`;
		} else {
			const currentLine = selection.active.line;
			const N = 10; // Number of lines before and after the current line to include
			const startLine = Math.max(0, currentLine - N);
			const endLine = Math.min(editor.document.lineCount - 1, currentLine + N);

			let lines = [];
			for (let i = startLine; i <= endLine; i++) {
				lines.push(editor.document.lineAt(i).text);
			}
			const currentLineText = editor.document.lineAt(currentLine).text;
			const contextAroundLine = lines.join('\n');
			selectedText = `Current line:
${currentLineText}

Context:
${contextAroundLine}`;
		}
	}

	return selectedText;
}

export function deactivate() {}
