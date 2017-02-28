import { IChanges } from './IChanges';
declare class IniFile<T> {
    private mStoredData;
    private mMutableData;
    constructor(data: T);
    readonly data: T;
    changes(): IChanges;
    apply(): void;
}
export default IniFile;
