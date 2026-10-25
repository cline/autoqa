export type UploadFileResult = {
    type: 'success',
    filename: string,
    result: any,
} | {
    type: 'failure',
    filename: string,
    error: string,
};

